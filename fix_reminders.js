const fs = require('fs');
const filePath = require('os').homedir() + '/Desktop/aj-bot/index.js';
let c = fs.readFileSync(filePath, 'utf8');

// Find the reminders section in the dashboard JS and add demo tasks after real reminders
const old = `\${data.reminders.length ? data.reminders.map(r => \`
          <div class="rem-item">
            <div class="rem-icon">⏰</div>
            <div>
              <div class="rem-msg">\${r.message}</div>
              <div class="rem-time">\${fmtTime(r.remind_at)}</div>
            </div>
          </div>
        \`).join('') : '<div class="empty">No reminders set</div>'}`;

const newStr = `<div style="font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.2);margin-bottom:10px;">SATURDAY</div>
        <div class="rem-item"><span style="font-size:13px;flex-shrink:0;">✅</span><div><div class="rem-msg" style="color:rgba(34,221,136,0.8);text-decoration:line-through;opacity:0.7;">Follow up on 4 Warm Leads for Overflow</div></div></div>
        <div class="rem-item"><span style="font-size:13px;flex-shrink:0;">🟡</span><div><div class="rem-msg">Remind Josh about AJ Marketing Campaign</div></div></div>
        <div class="rem-item"><span style="font-size:13px;flex-shrink:0;">🟡</span><div><div class="rem-msg">Adjust 2nd Brain</div></div></div>
        <div class="rem-item"><span style="font-size:13px;flex-shrink:0;">🟡</span><div><div class="rem-msg">X Growth Plan</div></div></div>
        \${data.reminders.length ? '<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:8px;">' + data.reminders.map(r => \`<div class="rem-item"><div class="rem-icon">⏰</div><div><div class="rem-msg">\${r.message}</div><div class="rem-time">\${fmtTime(r.remind_at)}</div></div></div>\`).join('') + '</div>' : ''}`;

if (c.includes(old)) {
  c = c.replace(old, newStr);
  fs.writeFileSync(filePath, c);
  console.log('Done - demo reminders added');
} else {
  console.log('Pattern not found - searching for similar...');
  const idx = c.indexOf('No reminders set');
  console.log('No reminders set at index:', idx);
  console.log('Context:', c.substring(idx-200, idx+50));
}
