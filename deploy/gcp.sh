#!/usr/bin/env bash
# Run the AI City Planner server on a Google Cloud VM.
#
# Needs the gcloud CLI, logged in (gcloud auth login) with a
# project that has billing and the Compute Engine API enabled
# (gcloud config set project PROJECT_ID).
#
#   deploy/gcp.sh up            create the VM if needed, upload the
#                               code, install, start the server
#   deploy/gcp.sh tunnel        forward http://localhost:8000 to it
#                               (keep running while you use the app)
#   deploy/gcp.sh sync          upload the current code, restart
#   deploy/gcp.sh data          copy the prepared land cover files
#                               from tools/data (skips downloads)
#   deploy/gcp.sh prefetch R    download + prepare Geofabrik region R
#                               on the VM, e.g. "india"
#   deploy/gcp.sh ssh | status | stop | start | delete
#
# Settings (environment): VM_NAME, GCP_ZONE, GCP_MACHINE,
# GCP_DISK_GB, PORT, LOCAL_PORT (tunnel port here, if 8000 is
# taken by a local server). A stopped VM costs only its disk.

set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${VM_NAME:-city-planner}"
ZONE="${GCP_ZONE:-asia-south1-a}"          # Mumbai
MACHINE="${GCP_MACHINE:-e2-standard-4}"    # 4 vCPU, 16 GB RAM
DISK_GB="${GCP_DISK_GB:-50}"
PORT="${PORT:-8000}"
LOCAL_PORT="${LOCAL_PORT:-$PORT}"            # tunnel end on this machine
REMOTE_DIR="city-planner"                  # in the VM user's home

vm_ssh() {
    gcloud compute ssh "$NAME" --zone "$ZONE" "$@"
}

exists() {
    gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1
}

wait_for_ssh() {
    for _ in $(seq 1 30); do
        if vm_ssh --command true >/dev/null 2>&1; then
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
    local pkg
    pkg="$(package)"
    gcloud compute scp "$pkg" "$NAME:city-planner.tgz" --zone "$ZONE"
    rm -f "$pkg"
    vm_ssh --command "mkdir -p $REMOTE_DIR && tar xzf city-planner.tgz -C $REMOTE_DIR && rm city-planner.tgz && PORT=$PORT bash $REMOTE_DIR/deploy/vm-setup.sh"
}

case "${1:-}" in

    up)
        if ! exists; then
            echo "== Creating $NAME ($MACHINE, ${DISK_GB} GB) in $ZONE"
            gcloud compute instances create "$NAME" \
                --zone "$ZONE" \
                --machine-type "$MACHINE" \
                --image-family debian-12 \
                --image-project debian-cloud \
                --boot-disk-size "${DISK_GB}GB" \
                --boot-disk-type pd-balanced
        fi
        wait_for_ssh
        upload_and_setup
        echo
        echo "Ready. Now run:  deploy/gcp.sh tunnel"
        echo "and open http://localhost:$PORT/ in your browser."
        ;;

    sync)
        upload_and_setup
        ;;

    data)
        shopt -s nullglob
        files=(tools/data/*-landcover.osm.pbf tools/data/*-landcover.wayidx.npz tools/data/geofabrik-index-v1.json)
        if [ ${#files[@]} -eq 0 ]; then
            echo "No prepared files in tools/data to copy." >&2
            exit 1
        fi
        vm_ssh --command "mkdir -p $REMOTE_DIR/tools/data"
        gcloud compute scp "${files[@]}" "$NAME:$REMOTE_DIR/tools/data/" --zone "$ZONE"
        ;;

    prefetch)
        region="${2:?usage: deploy/gcp.sh prefetch REGION   (e.g. india)}"
        vm_ssh --command "sudo systemctl stop city-planner; cd $REMOTE_DIR && tools/.venv/bin/python tools/serve.py --prefetch $region; sudo systemctl start city-planner"
        ;;

    tunnel)
        echo "Open http://localhost:$LOCAL_PORT/  (Ctrl+C here to close the tunnel)"
        vm_ssh -- -N -L "$LOCAL_PORT:localhost:$PORT"
        ;;

    ssh)
        vm_ssh
        ;;

    status)
        gcloud compute instances describe "$NAME" --zone "$ZONE" \
            --format="value(name,status,machineType.basename())"
        ;;

    stop | start)
        gcloud compute instances "$1" "$NAME" --zone "$ZONE"
        ;;

    delete)
        gcloud compute instances delete "$NAME" --zone "$ZONE"
        ;;

    *)
        sed -n '2,/^$/p' "$0"
        exit 1
        ;;
esac
