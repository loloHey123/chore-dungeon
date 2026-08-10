// Best-effort human alerting when Choremaster itself is in trouble (a failed
// send, a stuck poll loop, etc.) — separate from the normal chore chatter.
// iMessage (via Messages.app on this Mac) is the primary channel since it
// works even when Telegram itself is the thing that's broken. Callers should
// treat sendIMessage() as fallible and have their own fallback ready.
import { execFile } from 'node:child_process';

const ALERT_PHONE = process.env.ALERT_IMESSAGE_TARGET || '+19728001488';

function escapeForAppleScript(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function sendIMessage(text) {
  return new Promise((resolve, reject) => {
    const script = `
tell application "Messages"
	set targetService to 1st service whose service type = iMessage
	set targetBuddy to buddy "${escapeForAppleScript(ALERT_PHONE)}" of targetService
	send "${escapeForAppleScript(text)}" to targetBuddy
end tell`;
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      resolve();
    });
  });
}
