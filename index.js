// index.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const CoinPayments = require('coinpayments');
const { Low, JSONFile } = require('lowdb');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing in .env');
  process.exit(1);
}

const ADMINS = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const coinPaymentsClient = new CoinPayments({
  key: process.env.COINPAYMENTS_KEY || '',
  secret: process.env.COINPAYMENTS_SECRET || ''
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// LowDB setup (file DB)
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data = db.data || { orders: [], users: [] };
  await db.write();
}
initDb();

// load products
const productsPath = path.join(__dirname, 'products.json');
function loadProducts() {
  if (!fs.existsSync(productsPath)) {
    fs.writeFileSync(productsPath, JSON.stringify({}, null, 2));
  }
  return JSON.parse(fs.readFileSync(productsPath));
}
function saveProducts(obj) {
  fs.writeFileSync(productsPath, JSON.stringify(obj, null, 2));
}

const bot = new Telegraf(BOT_TOKEN);

// helper: list available card types
function getCardTypes() {
  const p = loadProducts();
  return Object.keys(p).length ? Object.keys(p) : ['Amazon','iTunes','Google Play','Flexepin','Crypto Voucher','Razer Gold','Netflix','Visa'];
}

const DENOMS = [10, 25, 50, 100, 200, 500]; // allowed denominations

// state store for multi-step flows (simple in-memory)
const flow = {};

// Start
bot.start(async (ctx) => {
  const name = [ctx.from.first_name || '', ctx.from.last_name || ''].join(' ').trim();
  await ctx.reply(`Hello ${name || 'there'}! Welcome to the GiftCard Store.\nChoose a gift card type:`, Markup.inlineKeyboard(
    getCardTypes().map(t => [Markup.button.callback(t, `card_${t}`)])
  ));
});

// Card selection handler
bot.action(/card_(.+)/, async (ctx) => {
  const card = ctx.match[1];
  flow[ctx.from.id] = { card };
  // Ask region
  await ctx.answerCbQuery();
  await ctx.reply(`Selected: ${card}\nPlease type region (e.g. US, UK, AU, GLOBAL)`);
});

// capture region as text
bot.on('text', async (ctx, next) => {
  const f = flow[ctx.from.id];
  if (!f) return next();
  if (!f.region) {
    const region = ctx.message.text.trim().toUpperCase();
    f.region = region;
    await ctx.reply(`Region set: ${region}\nChoose denomination:`, Markup.inlineKeyboard(
      DENOMS.map(d => Markup.button.callback(`${d} USD`, `denom_${d}`)).map(b => [b])
    ));
    return;
  }
  if (!f.denom) return next();
  return next();
});

// denom handler
bot.action(/denom_(\d+)/, async (ctx) => {
  const denom = Number(ctx.match[1]);
  const f = flow[ctx.from.id] || {};
  if (!f.card || !f.region) {
    await ctx.answerCbQuery('Please start with /start and select a card.');
    return;
  }
  f.denom = denom;
  f.quantity = 1;
  await ctx.answerCbQuery();
  await ctx.reply(`You chose ${f.card} - ${f.denom} USD - Region ${f.region}\nHow many do you want? (send a number, max 10)`);
});

// capture quantity
bot.on('message', async (ctx, next) => {
  if (!ctx.message || !ctx.message.text) return next();
  const f = flow[ctx.from.id];
  if (!f || !f.denom || !f.region || !f.card) return next();
  if (!f.quantityConfirmed) {
    const q = parseInt(ctx.message.text.trim());
    if (isNaN(q) || q < 1 || q > 10) {
      await ctx.reply('Please send a valid quantity number (1-10).');
      return;
    }
    f.quantity = q;
    f.quantityConfirmed = true;
    const total = f.denom * f.quantity;
    await ctx.reply(`Order summary:
Card: ${f.card}
Region: ${f.region}
Denom: ${f.denom} USD
Quantity: ${f.quantity}
Total: ${total} USD

Press Pay to create a crypto payment (CoinPayments).`, Markup.inlineKeyboard([
      Markup.button.callback('Pay with CoinPayments', 'pay_now'),
      Markup.button.callback('Cancel', 'cancel_order')
    ]));
    return;
  }
  return next();
});

// cancel
bot.action('cancel_order', async (ctx) => {
  delete flow[ctx.from.id];
  await ctx.answerCbQuery('Order canceled.');
  await ctx.reply('Order canceled. Use /start to begin again.');
});

// pay
bot.action('pay_now', async (ctx) => {
  await ctx.answerCbQuery();
  const f = flow[ctx.from.id];
  if (!f) {
    await ctx.reply('No active order. Use /start.');
    return;
  }
  const totalUSD = f.denom * f.quantity;
  // create order record
  const orderId = nanoid(10);
  const order = {
    id: orderId,
    userId: ctx.from.id,
    username: ctx.from.username || null,
    first_name: ctx.from.first_name || null,
    card: f.card,
    region: f.region,
    denom: f.denom,
    quantity: f.quantity,
    totalUSD,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  // save to db
  await db.read();
  db.data.orders.push(order);
  await db.write();

  // Create CoinPayments transaction
  try {
    // Build IPN URL
    const ipnUrl = `${BASE_URL}/ipn`;
    // Note: coinpayments.createTransaction takes amount and currency1/currency2.
    const txn = await new Promise((resolve, reject) => {
      coinPaymentsClient.createTransaction({
        currency1: 'USD',
        currency2: 'USDT.TRC20', // choose target currency; check correct code for TRC20 on CoinPayments
        amount: totalUSD,
        buyer_email: ctx.from.username ? `${ctx.from.username}@example.com` : undefined,
        custom: orderId,
        ipn_url: ipnUrl
      }, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    // txn will contain: amount, amount_total, address, txn_id, confirms_needed, qrcode_url etc.
    order.txn = txn;
    await db.write();

    await ctx.replyWithMarkdown(`✅ Order created (ID: \`${orderId}\`)\n\nPlease pay **${txn.amount} ${txn.address ? txn.payment : 'USDT'}** to the address below via your wallet:\n\nPayment address / details:\n\`${txn.address || JSON.stringify(txn)}\`\n\nAfter payment and confirmations, you will receive your gift card codes automatically.\n\nIf you want to cancel, contact admin.`, { reply_markup: { inline_keyboard: [[{ text: 'Refresh status', callback_data: `check_${orderId}` }]] } });

    // clear flow
    delete flow[ctx.from.id];

  } catch (err) {
    console.error('CoinPayments createTransaction error:', err);
    await ctx.reply('Failed to create CoinPayments transaction. Try again later.');
  }
});

// check order status manually
bot.action(/check_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.read();
  const order = db.data.orders.find(o => o.id === orderId);
  if (!order) {
    await ctx.answerCbQuery('Order not found.');
    return;
  }
  await ctx.answerCbQuery();
  await ctx.reply(`Order ${orderId} status: ${order.status}\nTransaction: ${order.txn ? JSON.stringify({ txn_id: order.txn.txn_id, amount: order.txn.amount }) : 'N/A'}`);
});

// Admin commands
bot.command('admin', async (ctx) => {
  const uname = ctx.from.username || '';
  if (!ADMINS.includes(uname)) {
    return ctx.reply('Access denied. Admins only.');
  }
  // show pending orders
  await db.read();
  const pending = db.data.orders.filter(o => o.status === 'pending');
  if (!pending.length) return ctx.reply('No pending orders.');
  let text = 'Pending orders:\n';
  for (const o of pending) {
    text += `ID:${o.id} ${o.card} ${o.denom}x${o.quantity} USD:${o.totalUSD} by @${o.username || 'unknown'}\n`;
  }
  text += '\nUse /deliver ORDER_ID to deliver codes (pop from products) or /markpaid ORDER_ID to mark paid manually.';
  await ctx.reply(text);
});

// mark paid manually
bot.command('markpaid', async (ctx) => {
  const uname = ctx.from.username || '';
  if (!ADMINS.includes(uname)) return ctx.reply('Access denied.');
  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  if (!id) return ctx.reply('Usage: /markpaid ORDER_ID');
  await db.read();
  const order = db.data.orders.find(o => o.id === id);
  if (!order) return ctx.reply('Order not found.');
  order.status = 'paid';
  order.paid_at = new Date().toISOString();
  await db.write();
  await ctx.reply('Order marked paid. Use /deliver ' + id + ' to deliver codes.');
});

// deliver codes to user (admin)
bot.command('deliver', async (ctx) => {
  const uname = ctx.from.username || '';
  if (!ADMINS.includes(uname)) return ctx.reply('Access denied.');
  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  if (!id) return ctx.reply('Usage: /deliver ORDER_ID');
  await db.read();
  const order = db.data.orders.find(o => o.id === id);
  if (!order) return ctx.reply('Order not found.');
  if (order.status !== 'paid') return ctx.reply('Order not paid yet.');
  // pop codes from products.json
  const products = loadProducts();
  const card = order.card;
  const region = order.region;
  const denom = String(order.denom);
  if (!products[card] || !products[card][region] || !products[card][region][denom] || !products[card][region][denom].length) {
    return ctx.reply('No stock for that card/region/denomination.');
  }
  const codes = products[card][region][denom].splice(0, order.quantity);
  saveProducts(products);

  // update order
  order.status = 'delivered';
  order.delivered_at = new Date().toISOString();
  order.codes = codes;
  await db.write();

  // send codes to buyer (if bot can message)
  try {
    await bot.telegram.sendMessage(order.userId, `🎉 Your order ${order.id} has been delivered. Here are your codes:\n\n${codes.join('\n')}\n\nThank you for buying!`);
    await ctx.reply('Codes delivered to user.');
  } catch (err) {
    console.error('Failed to send codes to user:', err);
    await ctx.reply('Failed to send codes to user (maybe user blocked the bot). Codes added to order record.');
  }
});

// IPN endpoint for CoinPayments
// CoinPayments will POST to /ipn with IPN data. We verify HMAC header using IPN secret.
app.post('/ipn', (req, res) => {
  // Verification: CoinPayments sends HMAC header 'hmac'
  const hmac = req.headers['hmac'] || req.headers['HMAC'] || req.headers['Hmac'];
  const ipnSecret = process.env.COINPAYMENTS_IPN_SECRET || '';
  if (!ipnSecret) {
    console.error('IPN secret not set');
    return res.status(500).send('IPN secret missing');
  }
  // compute HMAC SHA512 of raw body
  const crypto = require('crypto');
  const rawBody = JSON.stringify(req.body);
  const computedHmac = crypto.createHmac('sha512', ipnSecret).update(rawBody).digest('hex');

  if (!hmac || computedHmac !== hmac) {
    console.warn('Invalid IPN HMAC');
    return res.status(403).send('Invalid HMAC');
  }

  const data = req.body;
  const custom = data.custom; // we used orderId in custom field
  const status = Number(data.status); // coinpayments status code (100 = complete)
  console.log('IPN received for custom:', custom, 'status', status);

  (async () => {
    await db.read();
    const order = db.data.orders.find(o => o.id === custom);
    if (!order) {
      console.warn('Order not found for IPN custom:', custom);
      return res.status(200).send('OK');
    }
    // update transaction info
    order.txn = order.txn || {};
    order.txn.ipn = data;

    if (status >= 100 || status === 2) {
      // paid and confirmed
      order.status = 'paid';
      order.paid_at = new Date().toISOString();
      await db.write();
      console.log('Order marked paid:', custom);

      // auto-deliver if stock exists
      const products = loadProducts();
      const card = order.card;
      const region = order.region;
      const denom = String(order.denom);
      if (products[card] && products[card][region] && products[card][region][denom] && products[card][region][denom].length >= order.quantity) {
        const codes = products[card][region][denom].splice(0, order.quantity);
        saveProducts(products);
        order.status = 'delivered';
        order.delivered_at = new Date().toISOString();
        order.codes = codes;
        await db.write();
        // send codes to buyer
        try {
          await bot.telegram.sendMessage(order.userId, `🎉 Payment received for order ${order.id}. Here are your codes:\n\n${codes.join('\n')}\n\nThanks!`);
        } catch (err) {
          console.warn('Failed to DM user codes:', err);
        }
      } else {
        // insufficient stock; notify admins
        for (const admin of ADMINS) {
          try {
            await bot.telegram.sendMessageByUsername
          } catch (e) {}
        }
        // notify admin by telegram id not implemented here; admins should run /admin and /deliver
      }
    } else {
      // pending/unconfirmed - just store update
      order.status = 'pending';
      await db.write();
    }
  })();

  res.status(200).send('OK');
});

// helper to send message by username (fallback)
bot.telegram.sendMessageByUsername = async (username, text) => {
  try {
    if (!username) throw new Error('no username');
    // get chat via @username is not supported in standard API; we require admin to start bot
    // fallback: do nothing
    return;
  } catch (err) {
    console.error('sendMessageByUsername not implemented', err);
  }
};

app.get('/', (req, res) => res.send('GiftCard Telegram Bot alive'));

// Start express server and bot
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  // start bot polling (or you may configure webhook)
  try {
    await bot.launch();
    console.log('Bot started (polling)');
  } catch (err) {
    console.error('Bot failed to start:', err);
  }
});

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
