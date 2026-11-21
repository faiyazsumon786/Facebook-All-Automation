const { startProfile, stopProfile, getSession } = require('./manager');
const { connectOverCDP } = require('./cdp');

function parseSpintax(text) {
  if (!text || typeof text !== 'string') return '';
  const regex = /\{([^{}]+)\}/g;
  let result = text;
  while (regex.test(result)) {
    result = result.replace(regex, (_, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)].trim();
    });
  }
  return result;
}

/**
 * Automatically replies to comments on a Facebook Reel or Page Feed
 * 
 * @param {string} profileName Profile name
 * @param {object} options { reelUrl, pageId, spintaxReply, maxReplies, onLog }
 */
async function autoReplyComments(profileName, options = {}) {
  const { reelUrl, pageId, spintaxReply = 'Thanks for watching! {Check out our page for more!|Glad you liked it!}', maxReplies = 5 } = options;
  const onLog = options.onLog || (() => {});
  const log = (msg) => onLog(`[auto-reply] ${msg}`);

  const targetUrl = reelUrl || (pageId ? `https://www.facebook.com/${pageId}` : 'https://www.facebook.com/');
  log(`Starting profile ${profileName} to reply to comments...`);

  let session = getSession(profileName);
  const wasAlreadyRunning = session && session.state === 'running';

  if (!wasAlreadyRunning) {
    await startProfile(profileName, { startMaximized: true });
    session = getSession(profileName);
  }

  if (!session || !session.cdpPort) {
    throw new Error(`Could not connect to profile ${profileName}`);
  }

  let connection;
  let repliesCount = 0;

  try {
    connection = await connectOverCDP(session.cdpPort);
    const page = await connection.context.newPage();

    log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(3500);

    // Scroll slightly to reveal comments
    await page.evaluate(`(() => {
      window.scrollBy({ top: 400, behavior: 'smooth' });
    })()`).catch(() => {});
    await page.waitForTimeout(2000);

    // Execute comment reply scan and engagement inside page DOM
    log(`Scanning for viewer comments to engage...`);
    const scanResult = await page.evaluate(`(async () => {
      // Find comment blocks or reply triggers
      const replyButtons = Array.from(document.querySelectorAll('div[role="button"], span, a'))
        .filter(el => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          return txt === 'reply' || txt === 'উত্তর দিন' || txt === 'responder';
        });

      return { foundReplyButtons: replyButtons.length };
    })()`).catch(() => ({ foundReplyButtons: 0 }));

    log(`Found ${scanResult.foundReplyButtons || 0} candidate comment reply slots.`);

    // Loop through comments and reply
    for (let i = 0; i < Math.min(maxReplies, Math.max(1, scanResult.foundReplyButtons)); i++) {
      const textToPost = parseSpintax(spintaxReply);
      
      const replied = await page.evaluate(`(async (replyText, index) => {
        // Find visible reply buttons
        const buttons = Array.from(document.querySelectorAll('div[role="button"], span, a'))
          .filter(el => {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            return txt === 'reply' || txt === 'উত্তর দিন' || txt === 'responder';
          });

        if (!buttons[index]) return { success: false, reason: 'Button index not found' };
        
        const btn = buttons[index];
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        
        await new Promise(r => setTimeout(r, 1200));

        // Find active comment input box
        const input = document.activeElement || document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (!input) return { success: false, reason: 'Comment input not active' };

        // Type reply text
        document.execCommand('insertText', false, replyText);
        await new Promise(r => setTimeout(r, 600));

        // Dispatch Enter key
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

        return { success: true };
      })(${JSON.stringify(textToPost)}, ${i})`).catch(err => ({ success: false, reason: err.message }));

      if (replied && replied.success) {
        repliesCount++;
        log(`Sent reply #${repliesCount}: "${textToPost}"`);
        await page.waitForTimeout(2500); // Wait 2.5s between replies for human pacing
      } else {
        log(`Could not reply to comment #${i + 1}: ${replied?.reason || 'Unknown'}`);
      }
    }

    try { page.session?.close(); } catch {}
  } finally {
    if (!wasAlreadyRunning) {
      log(`Closing profile browser after comment engagement...`);
      await stopProfile(profileName).catch(() => {});
    }
  }

  log(`Auto-reply session finished. Sent ${repliesCount} replies.`);
  return {
    ok: true,
    profileName,
    repliesCount
  };
}

module.exports = {
  autoReplyComments
};
