// index.js
const express = require('express');
const { Telegraf } = require('telegraf');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const BOT_TOKEN = '8531282179:AAELVBtd9XVp9ysTo3iaLwf7OMNIFNNXd6E';
const ADMIN_ID = 7332885696;
const CHANNEL_USERNAME = '@ff_panel2299';
const AD_REDIRECT_TARGET = 'https://www.effectivegatecpm.com/tdmyha5cz?key=1e12d6c337e39a5c5d8d3a2093cf1748';
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable missing!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render internal DB এর জন্য
});

// ================== Helper Functions ==================
async function ensureUser(tg) {
  const res = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tg]);
  if (res.rowCount) return res.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, username, referral_code, created_at)
     VALUES ($1,$2, substring(md5(random()::text) from 1 for 6), now()) RETURNING *`,
    [tg, null]
  );
  return rows[0];
}

async function getBalance(userId) {
  const r = await pool.query('SELECT COALESCE(SUM(CASE WHEN type=$2 THEN amount WHEN type=$3 THEN -amount ELSE 0 END),0) as bal FROM ledger WHERE user_id=$1', [userId, 'credit', 'debit']);
  return Number(r.rows[0].bal || 0);
}

async function isMemberOfChannel(tgId) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, tgId);
    return ['creator', 'administrator', 'member','restricted'].includes(member.status);
  } catch(e){ return false; }
}

async function ensureJoined(ctx) {
  const tgId = ctx.from.id;
  const u = await pool.query('SELECT id, joined_channel FROM users WHERE telegram_id=$1', [tgId]);
  if (u.rowCount === 0) { await ctx.reply('প্রথমে /start করো।'); return false; }
  const user = u.rows[0];
  if (!user.joined_channel) {
    const member = await isMemberOfChannel(tgId);
    if (!member) {
      await ctx.reply(`আপনাকে প্রথমে আমাদের চ্যানেল জয়েন করতে হবে:\n${CHANNEL_USERNAME}\nJOIN করে /joinchannel চালান।`);
      return false;
    } else { await pool.query('UPDATE users SET joined_channel=true WHERE telegram_id=$1', [tgId]); return true; }
  }
  return true;
}

// ================== Bot Commands ==================

// /start
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  const username = ctx.from.username || null;
  const text = ctx.message?.text || '';
  const parts = text.split(' ');
  let refcode = null;
  if (parts.length > 1) refcode = parts[1].trim();

  const userRes = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [tgId]);
  let user;
  if (userRes.rowCount === 0) {
    const create = await pool.query(
      `INSERT INTO users (telegram_id, username, referral_code, created_at)
       VALUES ($1,$2, substring(md5(random()::text) from 1 for 6), now()) RETURNING *`,
      [tgId, username]
    );
    user = create.rows[0];
  } else { user = userRes.rows[0]; }

  // Referral reward
  if (refcode) {
    const r = await pool.query('SELECT id, telegram_id FROM users WHERE referral_code=$1', [refcode]);
    if (r.rowCount && r.rows[0].telegram_id !== tgId) {
      const referrerId = r.rows[0].id;
      try {
        await pool.query('INSERT INTO referrals (referrer_id, referee_id, awarded, created_at) VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING', [referrerId, user.id, true]);
        await pool.query(`INSERT INTO ledger (user_id, amount, type, reason, ref_id, created_at) VALUES ($1, $2, 'credit', 'referral', $3, now())`, [referrerId, 30, `ref_${user.id}`]);
        try { await bot.telegram.sendMessage(r.rows[0].telegram_id, `🎉 আপনি নতুন রেফার্ড পেয়েছেন! +30 টাকা আপনার ব্যালেন্সে যোগ করা হয়েছে।`); } catch(e){ }
      } catch(e){}
    }
  }

  const member = await isMemberOfChannel(tgId);
  if (!member) {
    return ctx.replyWithMarkdown(`স্বাগতম *${username || ''}*! 👋\nএই বট ব্যবহার করার আগে আপনাকে আমাদের চ্যানেলে জয়েন করতে হবে:\n${CHANNEL_USERNAME}\n\nচ্যানেলে জয়েন করে /joinchannel চালান।`);
  } else {
    await pool.query('UPDATE users SET joined_channel=true WHERE telegram_id=$1', [tgId]);
    return ctx.reply(`স্বাগতম ${username || ''}!\nআপনি আমাদের চ্যানেলে জয়েন করেছেন — এখন আপনি /watchad, /refcode, /profile ইত্যাদি ব্যবহার করতে পারবেন।`);
  }
});

// /refcode
bot.command('refcode', async (ctx) => {
  const tgId = ctx.from.id;
  const r = await pool.query('SELECT referral_code FROM users WHERE telegram_id=$1', [tgId]);
  if (r.rowCount === 0) return ctx.reply('প্রথমে /start করুন।');
  return ctx.reply(`তোমার referral code: ${r.rows[0].referral_code}\nInvite link: https://t.me/${(await bot.telegram.getMe()).username}?start=${r.rows[0].referral_code}`);
});

// /profile
bot.command('profile', async (ctx) => {
  const tgId = ctx.from.id;
  const r = await pool.query('SELECT id, username, joined_channel, join_rewarded FROM users WHERE telegram_id=$1', [tgId]);
  if (r.rowCount === 0) return ctx.reply('প্রথমে /start করুন।');
  const user = r.rows[0];
  const balance = await getBalance(user.id);
  const msg = `🔸 User: ${user.username || ''}\n🔸 Balance: ${balance} Tk\n🔸 Joined Channel: ${user.joined_channel ? 'Yes' : 'No'}\n🔸 Join Reward Taken: ${user.join_rewarded ? 'Yes' : 'No'}`;
  return ctx.reply(msg);
});

// /joinchannel
bot.command('joinchannel', async (ctx) => {
  const ok = await ensureJoined(ctx);
  if (!ok) return;

  const tgId = ctx.from.id;
  const u = await pool.query('SELECT id, join_rewarded FROM users WHERE telegram_id=$1', [tgId]);
  if(u.rowCount===0) return ctx.reply('প্রথমে /start করো।');
  const user = u.rows[0];
  if(user.join_rewarded) return ctx.reply('আপনি আগে থেকেই join reward পেয়েছেন।');

  await pool.query(`INSERT INTO ledger (user_id, amount, type, reason, ref_id, created_at) VALUES ($1, $2, 'credit', 'channel_join', $3, now())`, [user.id, 50, `join_${user.id}`]);
  await pool.query('UPDATE users SET joined_channel=true, join_rewarded=true WHERE id=$1', [user.id]);
  return ctx.reply('ধন্যবাদ! আপনি চ্যানেল জয়েন করার জন্য +50 Tk পেয়েছেন।');
});

// /watchad
bot.command('watchad', async (ctx) => {
  const ok = await ensureJoined(ctx);
  if (!ok) return;
  const tgId = ctx.from.id;
  const host = process.env.BOT_HOST || `http://localhost:${PORT}`;
  const redirectUrl = `${host}/r?uid=${tgId}`;
  return ctx.reply(`🎬 Ad দেখতে এখানে ক্লিক করো:\n${redirectUrl}\n\nNote: প্রতিদিন সর্বোচ্চ ২০টি Ad দেখা যাবে।`);
});

// /withdraw
bot.command('withdraw', async (ctx)=>{
  const ok = await ensureJoined(ctx); if(!ok) return;
  const tgId = ctx.from.id;
  const text = ctx.message.text||'';
  const parts = text.split(' ').slice(1);
  if(parts.length<2) return ctx.reply('Usage: /withdraw <amount> <method> <account_info_optional>');
  const amount = Number(parts[0]);
  if(isNaN(amount)||amount<=0) return ctx.reply('Invalid amount.');
  if(amount<1000) return ctx.reply('Minimum withdraw is 1000 Tk.');
  const method = parts[1];
  const account_info = parts.slice(2).join(' ')||null;

  const u = await pool.query('SELECT id FROM users WHERE telegram_id=$1',[tgId]);
  if(u.rowCount===0) return ctx.reply('First /start please.');
  const userId = u.rows[0].id;
  const bal = await getBalance(userId);
  if(bal<amount) return ctx.reply(`আপনার ব্যালেন্স যথেষ্ট নয়। আপনার ব্যালেন্স: ${bal} Tk`);

  await pool.query('INSERT INTO withdraws (user_id, amount, method, account_info, status, created_at) VALUES ($1,$2,$3,$4,$5,now())',[userId, amount, method, account_info,'pending']);
  await bot.telegram.sendMessage(ADMIN_ID, `📝 Withdraw request:\nUser: ${tgId}\nAmount: ${amount}\nMethod: ${method}\nInfo: ${account_info}`);
  return ctx.reply('✅ Withdraw request পাঠানো হয়েছে। Admin manual payment করবেন।');
});

// ================== Ad Redirect Endpoint ==================
app.get('/r', async (req,res)=>{
  const uid = req.query.uid;
  if(!uid) return res.status(400).send('bad');
  try{
    const u = await pool.query('SELECT id FROM users WHERE telegram_id=$1',[uid]);
    if(u.rowCount===0) return res.redirect(AD_REDIRECT_TARGET);
    const userId = u.rows[0].id;

    // আজকের clicked Ad সংখ্যা গণনা
    const today = new Date();
    today.setHours(0,0,0,0);
    const last = await pool.query('SELECT COUNT(*) FROM ad_clicks WHERE user_id=$1 AND clicked_at >= $2',[userId, today]);
    const todayCount = Number(last.rows[0].count || 0);

    if(todayCount >= 20){
      try { await bot.telegram.sendMessage(uid, `⚠️ আজ আপনি সর্বোচ্চ ২০টি Ad দেখেছেন। ২৪ ঘণ্টা পরে আবার চেষ্টা করুন।`);}catch(e){}
      return res.redirect(AD_REDIRECT_TARGET);
    }

    // Ad reward দেওয়া
    await pool.query('INSERT INTO ad_clicks (user_id, clicked_at) VALUES ($1, now())',[userId]);
    await pool.query(`INSERT INTO ledger (user_id, amount, type, reason, ref_id, created_at) VALUES ($1, $2, 'credit', 'ad_click', $3, now())`, [userId, 20, `ad_${Date.now()}`]);
    try{ await bot.telegram.sendMessage(uid, `🎉 আপনি Ad দেখে +20 Tk পেয়েছেন! (${todayCount+1}/20 আজ) `);}catch(e){}
