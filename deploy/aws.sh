#!/usr/bin/env bash
# Run the AI City Planner server on an AWS EC2 VM.
#
# Needs the AWS CLI v2, configured (aws configure) with a user
# that may manage EC2, and a default VPC in the region.
#
#   deploy/aws.sh up            create the VM if needed, upload the
#                               code, install, start the server
#   deploy/aws.sh tunnel        forward http://localhost:8000 to it
#                               (keep running while you use the app)
#   deploy/aws.sh sync          upload the current code, restart
#   deploy/aws.sh data          copy the prepared land cover files
#                               from tools/data (skips downloads)
#   deploy/aws.sh prefetch R    download + prepare Geofabrik region R
#                               on the VM, e.g. "india"
#   deploy/aws.sh ssh | status | stop | start | delete
#
# Only SSH is opened, and only from your current public IP (each
# command re-adds it, in case your IP changed). The app is reached
# through the SSH tunnel. Settings (environment): VM_NAME,
# AWS_REGION, AWS_TYPE, AWS_DISK_GB, AWS_KEY_FILE, PORT,
# LOCAL_PORT (tunnel port here, if 8000 is taken). A stopped
# VM costs only its disk; its public IP changes on every start.

set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${VM_NAME:-city-planner}"
REGION="${AWS_REGION:-ap-south-1}"         # Mumbai
TYPE="${AWS_TYPE:-m6i.xlarge}"             # 4 vCPU, 16 GB RAM
DISK_GB="${AWS_DISK_GB:-50}"
PORT="${PORT:-8000}"
LOCAL_PORT="${LOCAL_PORT:-$PORT}"            # tunnel end on this machine
KEY_NAME="$NAME-key"
KEY_FILE="${AWS_KEY_FILE:-$HOME/.ssh/$NAME-aws.pem}"
SG_NAME="$NAME-ssh"
SSH_USER="admin"                           # Debian AMIs
REMOTE_DIR="city-planner"
DEBIAN_OWNER="136693071363"                # official Debian AMIs

ec2() {
    aws --region "$REGION" ec2 "$@"
}

instance_id() {
    ec2 describe-instances \
        --filters "Name=tag:Name,Values=$NAME" \
                  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
        --query 'Reservations[0].Instances[0].InstanceId' --output text
}

public_ip() {
    ec2 describe-instances --instance-ids "$1" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

ensure_key() {
    if [ -f "$KEY_FILE" ]; then
        return
    fi
    if ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
        echo "Key pair $KEY_NAME exists in AWS but $KEY_FILE is missing." >&2
        echo "Set AWS_KEY_FILE to it, or delete the key pair in the console." >&2
        exit 1
    fi
    mkdir -p "$(dirname "$KEY_FILE")"
    ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 \
        --query KeyMaterial --output text > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
}

security_group() {
    local vpc sg
    vpc="$(ec2 describe-vpcs --filters Name=is-default,Values=true \
        --query 'Vpcs[0].VpcId' --output text)"
    if [ "$vpc" = "None" ]; then
        echo "No default VPC in $REGION." >&2
        exit 1
    fi
    sg="$(ec2 describe-security-groups \
        --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$vpc" \
        --query 'SecurityGroups[0].GroupId' --output text)"
    if [ "$sg" = "None" ]; then
        sg="$(ec2 create-security-group --group-name "$SG_NAME" --vpc-id "$vpc" \
            --description "SSH for $NAME" --query GroupId --output text)"
    fi
    echo "$sg"
}

allow_my_ip() {
    local ip
    ip="$(curl -sf https://checkip.amazonaws.com | tr -d '[:space:]')"
    ec2 authorize-security-group-ingress --group-id "$(security_group)" \
        --protocol tcp --port 22 --cidr "$ip/32" >/dev/null 2>&1 || true
}

# Address of the running VM (starts nothing).
vm_ip() {
    local id ip
    id="$(instance_id)"
    if [ "$id" = "None" ]; then
        echo "No VM named $NAME in $REGION; run: deploy/aws.sh up" >&2
        exit 1
    fi
    ip="$(public_ip "$id")"
    if [ "$ip" = "None" ]; then
        echo "VM $id is not running; run: deploy/aws.sh start" >&2
        exit 1
    fi
    echo "$ip"
}

vm_ssh() {
    local ip="$1"
    shift
    ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new "$SSH_USER@$ip" "$@"
}

wait_for_ssh() {
    for _ in $(seq 1 30); do
        if vm_ssh "$1" -o ConnectTimeout=5 true >/dev/null 2>&1; then
            return 0
        fi
        sleep 5
    done
    echo "The VM does not answer over SSH yet; try again in a minute." >&2
    exit 1
}

# The project files as they are in the working tree (uncommitted
# edits and new files included); nothing .gitignore excludes, so
# no downloaded data and no virtualenv.
package() {
    local out
    out="$(mktemp -t city-planner-XXXXXX.tgz)"
    git ls-files -z --cached --others --exclude-standard |
        while IFS= read -r -d '' f; do
            [ -e "$f" ] && printf '%s\0' "$f"
        done |
        tar --null -T - -czf "$out"
    echo "$out"
}

upload_and_setup() {
    local ip="$1" pkg
    pkg="$(package)"
    scp -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new "$pkg" "$SSH_USER@$ip:city-planner.tgz"
    rm -f "$pkg"
    vm_ssh "$ip" "mkdir -p $REMOTE_DIR && tar xzf city-planner.tgz -C $REMOTE_DIR && rm city-planner.tgz && PORT=$PORT bash $REMOTE_DIR/deploy/vm-setup.sh"
}

case "${1:-}" in

    up)
        ensure_key
        allow_my_ip
        id="$(instance_id)"
        if [ "$id" = "None" ]; then
            read -r ami root <<<"$(ec2 describe-images --owners "$DEBIAN_OWNER" \
                --filters "Name=name,Values=debian-12-amd64-*" "Name=architecture,Values=x86_64" \
                --query 'sort_by(Images,&CreationDate)[-1].[ImageId,RootDeviceName]' --output text)"
            echo "== Creating $NAME ($TYPE, ${DISK_GB} GB, $ami) in $REGION"
            id="$(ec2 run-instances \
                --image-id "$ami" \
                --instance-type "$TYPE" \
                --key-name "$KEY_NAME" \
                --security-group-ids "$(security_group)" \
                --block-device-mappings "DeviceName=$root,Ebs={VolumeSize=$DISK_GB,VolumeType=gp3}" \
                --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
                --query 'Instances[0].InstanceId' --output text)"
        else
            ec2 start-instances --instance-ids "$id" >/dev/null
        fi
        ec2 wait instance-running --instance-ids "$id"
        ip="$(public_ip "$id")"
        wait_for_ssh "$ip"
        upload_and_setup "$ip"
        echo
        echo "Ready. Now run:  deploy/aws.sh tunnel"
        echo "and open http://localhost:$PORT/ in your browser."
        ;;

    sync)
        allow_my_ip
        upload_and_setup "$(vm_ip)"
        ;;

    data)
        allow_my_ip
        ip="$(vm_ip)"
        shopt -s nullglob
        files=(tools/data/*-landcover.osm.pbf tools/data/*-landcover.wayidx.npz tools/data/geofabrik-index-v1.json)
        if [ ${#files[@]} -eq 0 ]; then
            echo "No prepared files in tools/data to copy." >&2
            exit 1
        fi
        vm_ssh "$ip" "mkdir -p $REMOTE_DIR/tools/data"
        scp -i "$KEY_FILE" "${files[@]}" "$SSH_USER@$ip:$REMOTE_DIR/tools/data/"
        ;;

    prefetch)
        region="${2:?usage: deploy/aws.sh prefetch REGION   (e.g. india)}"
        allow_my_ip
        vm_ssh "$(vm_ip)" "sudo systemctl stop city-planner; cd $REMOTE_DIR && tools/.venv/bin/python tools/serve.py --prefetch $region; sudo systemctl start city-planner"
        ;;

    tunnel)
        allow_my_ip
        echo "Open http://localhost:$LOCAL_PORT/  (Ctrl+C here to close the tunnel)"
        vm_ssh "$(vm_ip)" -N -L "$LOCAL_PORT:localhost:$PORT"
        ;;

    ssh)
        allow_my_ip
        vm_ssh "$(vm_ip)"
        ;;

    status)
        ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" \
            --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress]' \
            --output text
        ;;

    stop)
        ec2 stop-instances --instance-ids "$(instance_id)" >/dev/null
        echo "Stopping (the disk is kept)."
        ;;

    start)
        id="$(instance_id)"
        ec2 start-instances --instance-ids "$id" >/dev/null
        ec2 wait instance-running --instance-ids "$id"
        echo "Running at $(public_ip "$id")."
        ;;

    delete)
        id="$(instance_id)"
        read -r -p "Terminate $id ($NAME) and its disk? [y/N] " answer
        if [ "$answer" = "y" ]; then
            ec2 terminate-instances --instance-ids "$id" >/dev/null
            echo "Terminating. The key pair and security group are kept (free)."
        fi
        ;;

    *)
        sed -n '2,/^$/p' "$0"
        exit 1
        ;;
esac
