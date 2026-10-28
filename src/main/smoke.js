'use strict';
// Dev-only smoke test: CRATESCOPE_SMOKE=out.png electron . <folder>
const fs = require('fs');
module.exports = function smoke(win, out) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
  win.webContents.once('did-finish-load', async () => {
    await wait(+process.env.CRATESCOPE_SMOKE_WAIT || 15000);
    const r = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelectorAll('.trow')[2];
      if (row) row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      return { rows: document.querySelectorAll('.trow').length, status: document.getElementById('status').textContent };
    })()`);
    console.log('smoke', JSON.stringify(r));
    await wait(1500);
    if (process.env.CRATESCOPE_SMOKE_JS) {
      console.log('smoke-js', JSON.stringify(await win.webContents.executeJavaScript(process.env.CRATESCOPE_SMOKE_JS)));
      await wait(1000);
    }
    if (!process.env.CRATESCOPE_SMOKE_JS) await win.webContents.executeJavaScript(`document.getElementById('audio').currentTime = 60; document.getElementById('btnPlay').click(); true`);
    await wait(1500);
    const img = await win.capturePage();
    fs.writeFileSync(out, img.toPNG());
    console.log('screenshot', out);
    require('electron').app.quit();
  });
};
