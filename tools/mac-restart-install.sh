#!/bin/bash
# Installs a scheduled restart of the church Mac: Wednesday 6:00 am and Saturday 9:00 pm (the Mac's own
# clock, Mountain time). OBS is quit cleanly first so it reopens without the Safe Mode prompt.
# Run once in Terminal on the church Mac; it asks for the Mac's password once (for the restart permission).
# Undo with:  curl -fsSL https://raw.githubusercontent.com/IlanOlivares/stream/main/tools/mac-restart-install.sh | bash -s -- --remove
set -euo pipefail
LABEL="org.abundant.mac-restart"
SCRIPT="$HOME/Library/Scripts/mac-restart.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUDOERS="/etc/sudoers.d/abundant-mac-restart"
ME="$(id -un)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$SCRIPT"
  sudo rm -f "$SUDOERS"
  echo "Removed the scheduled Mac restart."
  exit 0
fi

mkdir -p "$HOME/Library/Scripts" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Lets this user run exactly one root command without a password: an immediate restart.
TMP="$(mktemp)"
echo "$ME ALL=(root) NOPASSWD: /sbin/shutdown -r now" > "$TMP"
sudo visudo -cf "$TMP" >/dev/null
sudo install -m 0440 -o root -g wheel "$TMP" "$SUDOERS"
rm -f "$TMP"

cat > "$SCRIPT" <<'SH'
#!/bin/bash
# Scheduled restart. Quits OBS normally first (never force-kills: a clean quit means no Safe Mode prompt on
# the way back up). If OBS won't quit within 30 s (it asks first while streaming or recording), the restart
# is skipped so a live stream is never cut.
LOG="$HOME/Library/Logs/mac-restart.log"
say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say "scheduled restart starting"
if pgrep -x obs >/dev/null; then
  osascript -e 'tell application "OBS" to quit' >/dev/null 2>&1 || true
  for i in $(seq 1 30); do pgrep -x obs >/dev/null || break; sleep 1; done
  if pgrep -x obs >/dev/null; then
    say "OBS did not quit (streaming or recording?); restart skipped"
    curl -s -m 8 -H "Tags: warning" -d "⚠️ Scheduled church Mac restart skipped: OBS wouldn't quit (streaming or recording?)." https://ntfy.sh/abundant-stream-k7x2q9 >/dev/null || true
    exit 0
  fi
fi
curl -s -m 8 -H "Priority: low" -d "🔄 Church Mac is restarting (scheduled). Companion and OBS should be back within 5 minutes." https://ntfy.sh/abundant-stream-k7x2q9 >/dev/null || true
# Don't reopen whatever happened to be open (Chrome, Terminal…); only Login Items should start.
defaults write com.apple.loginwindow TALLogoutSavesState -bool false
defaults -currentHost delete com.apple.loginwindow TALAppsToRelaunchAtLogin >/dev/null 2>&1 || true
say "restarting"
sleep 3
sudo -n /sbin/shutdown -r now
SH
chmod +x "$SCRIPT"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  </array>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sudo -n -l /sbin/shutdown -r now >/dev/null && echo "Restart permission: OK"
echo "Installed: the Mac restarts Wednesday 6:00 am and Saturday 9:00 pm. Log: ~/Library/Logs/mac-restart.log"
echo "To test now (OBS quits, then the Mac restarts):  launchctl kickstart gui/\$(id -u)/$LABEL"
