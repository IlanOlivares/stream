#!/bin/bash
# Installs a daily 4:00 am clean restart of OBS on the church Mac.
# Run once in Terminal on the church Mac. Undo with:  bash obs-restart-install.sh --remove
set -euo pipefail
LABEL="org.abundant.obs-restart"
SCRIPT="$HOME/Library/Scripts/obs-restart.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT"
  echo "Removed the daily OBS restart."
  exit 0
fi

mkdir -p "$HOME/Library/Scripts" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$SCRIPT" <<'SH'
#!/bin/bash
# Daily clean OBS restart. Quits OBS normally (never force-kills): a clean quit means OBS reopens without
# the Safe Mode prompt. --disable-shutdown-check only matters on OBS 30-31 (32 removed it and ignores it).
LOG="$HOME/Library/Logs/obs-restart.log"
echo "$(date '+%F %T') restart starting" >> "$LOG"
if pgrep -x obs >/dev/null; then
  osascript -e 'tell application "OBS" to quit' >/dev/null 2>&1 || true
  for i in $(seq 1 30); do pgrep -x obs >/dev/null || break; sleep 1; done
  if pgrep -x obs >/dev/null; then
    echo "$(date '+%F %T') OBS did not quit within 30 s (streaming or recording?); left it running" >> "$LOG"
    exit 0
  fi
fi
sleep 5
open -a OBS --args --disable-shutdown-check
echo "$(date '+%F %T') OBS reopened" >> "$LOG"
SH
chmod +x "$SCRIPT"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: OBS restarts every day at 4:00 am. Log: ~/Library/Logs/obs-restart.log"
echo "To test now (OBS will close and reopen):  launchctl kickstart gui/\$(id -u)/$LABEL"
