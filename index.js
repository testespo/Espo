import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";
import { runCronJobs } from "./services/leaderboardCron.js";

const app = express();
/* ================= ENV ================= */

const REQUIRED_ENV = [
"FB_PROJECT_ID",
"FB_CLIENT_EMAIL",
"FB_PRIVATE_KEY",
"FB_DB_URL",
"ZAPUPI_API_KEY",
"ZAPUPI_SECRET_KEY",
"ADMIN_UID"
];

for (const key of REQUIRED_ENV) {
if (!process.env[key]) {
console.error(`Missing ENV variable: ${key}`);
process.exit(1);
}
}

/* ================= CORS ================= */

const allowedOrigins = [
"https://c.am4n-builds.workers.dev",
"https://elitepros-backend.onrender.com"
];

app.use(cors({
origin(origin,callback){

if(!origin) return callback(null,true);

if(allowedOrigins.includes(origin))
return callback(null,true);

console.log("Blocked CORS:",origin);
callback(new Error("Not allowed by CORS"));
},
methods:["GET","POST","OPTIONS"],
allowedHeaders:["Content-Type","Authorization"],
credentials:true
}));

app.options("*",cors());

app.use(express.json());
app.use(express.urlencoded({extended:true}));

/* ================= FIREBASE ================= */

if(!admin.apps.length){
admin.initializeApp({
credential:admin.credential.cert({
projectId:process.env.FB_PROJECT_ID,
clientEmail:process.env.FB_CLIENT_EMAIL,
privateKey:process.env.FB_PRIVATE_KEY.replace(/\\n/g,"\n")
}),
databaseURL:process.env.FB_DB_URL
});
}

const db = admin.database();

/* ================= AUTH ================= */

async function verifyFirebaseToken(req,res,next){
try{
const token = req.headers.authorization?.split("Bearer ")[1];
if(!token) return res.status(401).json({error:"Unauthorized"});
const decoded = await admin.auth().verifyIdToken(token);
req.uid = decoded.uid;
next();
}catch{
return res.status(401).json({error:"Invalid token"});
}
}

async function verifyAdmin(req,res,next){
try{
const token = req.headers.authorization?.split("Bearer ")[1];
if(!token) return res.status(401).json({error:"Unauthorized"});
const decoded = await admin.auth().verifyIdToken(token);
if(decoded.uid !== process.env.ADMIN_UID)
return res.status(403).json({error:"Admin only"});
req.uid = decoded.uid;
next();
}catch{
return res.status(401).json({error:"Invalid token"});
}
}

/* ================= ROOT ================= */

app.get("/",(_,res)=>
res.json({status:"OK"})
);

/* ======================================================
CREATE PAYMENT (WITH REAL GATEWAY RESPONSE LOGGING)
====================================================== */

app.post(
"/create-payment",
verifyFirebaseToken,
async (req,res)=>{

try{

const uid = req.uid;
const amount = Number(req.body.amount);

if(!Number.isFinite(amount) || amount < 1)
return res.status(400).json({error:"Invalid amount"});

const orderId = "ORD" + Date.now();

const redirectUrl =
"https://testingwithme.infinityfree.me/wallet.html";

/* ================= BUILD REQUEST BODY ================= */

const params = new URLSearchParams();

params.append("token_key", process.env.ZAPUPI_API_KEY);
params.append("secret_key", process.env.ZAPUPI_SECRET_KEY);
params.append("amount", amount.toString());
params.append("order_id", orderId);
params.append("remark", "Wallet Deposit");
params.append("redirect_url", redirectUrl);

/* ================= DEBUG REQUEST ================= */

console.log("ZAPUPI REQUEST:", params.toString());

/* ================= CALL ZAPUPI ================= */

const zapupiRes = await fetch(
"https://api.zapupi.com/api/create-order",
{
method:"POST",
headers:{
"Content-Type":"application/x-www-form-urlencoded",
"Accept":"application/json"
},
body: params.toString()
}
);

/* ================= RAW RESPONSE ================= */

const rawResponse = await zapupiRes.text();

console.log("ZAPUPI RAW RESPONSE:", rawResponse);

/* ================= STORE RESPONSE ================= */

await db.ref("gatewayLogs/${orderId}").set({
timestamp: Date.now(),
request: params.toString(),
response: rawResponse
});

/* ================= SAFE JSON PARSE ================= */

let zapupi;

try{
zapupi = JSON.parse(rawResponse);
}catch{

return res.status(502).json({
error:"Invalid gateway response",
raw: rawResponse
});

}

/* ================= CHECK GATEWAY STATUS ================= */

if(zapupi.status !== "success"){

return res.status(502).json({
error:"Gateway error",
gateway: zapupi
});

}

/* ================= SAVE TRANSACTION ================= */

await db.ref("users/${uid}/transactions/${orderId}").set({
transactionId: orderId,
type: "deposit",
amount,
status: "pending",
timestamp: Date.now()
});

/* ================= SAVE ORDER ================= */

await db.ref("orders/${orderId}").set({
uid,
amount,
status:"pending",
locked:false,
createdAt: Date.now()
});

/* ================= RETURN REAL RESPONSE ================= */

res.json({
order_id: orderId,
gateway_response: zapupi
});

}catch(err){

console.error("CREATE PAYMENT ERROR:", err);

res.status(500).json({
error:"Create payment failed",
message: err.message
});

}

});


/* ======================================================
WEBHOOK
====================================================== */

app.post("/zapupi-webhook",async(req,res)=>{

try{

const{order_id}=req.body;

if(!order_id)
return res.status(400)
.send("Invalid webhook");

const orderRef=
db.ref(`orders/${order_id}`);

const lockResult=
await orderRef.transaction(order=>{

if(!order)return order;
if(order.status==="success")
return order;

if(order.locked===true)
return;

order.locked=true;

return order;
});

if(!lockResult.committed)
return res.status(200)
.send("Already processing");

const order=
lockResult.snapshot.val();

if(!order)
return res.status(404)
.send("Order not found");

const{uid,amount}=order;

const verifyBody=
new URLSearchParams({
token_key:process.env.ZAPUPI_API_KEY,
secret_key:process.env.ZAPUPI_SECRET_KEY,
order_id
});

const verifyRes=
await fetch(
"https://api.zapupi.com/api/order-status",
{
method:"POST",
headers:{
"Content-Type":
"application/x-www-form-urlencoded"
},
body:verifyBody.toString()
});

const zapupi=
JSON.parse(await verifyRes.text());

if(
!zapupi.data ||
String(zapupi.data.status)
.toLowerCase()!=="success"
){

await orderRef.update({
locked:false
});

return res.status(200)
.send("Not paid");
}

/* CREDIT WALLET */

await db.ref(
`users/${uid}/wallet/deposited`
).transaction(
v=>(Number(v)||0)+Number(amount)
);

await db.ref().update({

[`orders/${order_id}/status`]:"success",
[`orders/${order_id}/locked`]:false,

[`users/${uid}/transactions/${order_id}/status`]:"success",

[`users/${uid}/transactions/${order_id}/confirmedAt`]:
Date.now()

});

res.send("OK");

}catch(err){

console.error("WEBHOOK ERROR:",err);

res.status(500).send("Error");
}
});


/* ======================================================
JOIN MATCH (STABLE BALANCE + RACE SAFE SLOT)
====================================================== */

app.post("/join-match", verifyFirebaseToken, async (req,res)=>{

try{

const uid = req.uid;
const {matchId,ign} = req.body;

if(!matchId || !ign)
return res.json({error:"INVALID_DATA"});

const matchRef = db.ref(`matches/upcoming/${matchId}`);
const walletRef = db.ref(`users/${uid}/wallet`);

/* ======================================================
STEP 1 — READ WALLET FIRST (same logic as old endpoint)
====================================================== */

const walletSnap = await walletRef.once("value");

const wallet = walletSnap.val() || {};

let dep = Number(wallet.deposited ?? 0);
let win = Number(wallet.winnings ?? 0);

console.log("Wallet:",dep,win);   // debug

/* ======================================================
STEP 2 — GET MATCH
====================================================== */

const matchSnap = await matchRef.once("value");

if(!matchSnap.exists())
return res.json({error:"MATCH_NOT_FOUND"});

const matchData = matchSnap.val();

const entryFee = Number(matchData.entryFee ?? 0);

/* BALANCE CHECK */

if(dep + win < entryFee)
return res.json({error:"INSUFFICIENT_BALANCE"});

/* ======================================================
STEP 3 — SLOT LOCK (TRANSACTION)
====================================================== */

const slotTxn = await matchRef.transaction(match=>{

if(!match) return match;

if(!match.players)
match.players = {};

if(match.players[uid])
return match;

const count = Object.keys(match.players).length;

if(count >= match.slots)
return;

match.players[uid] = {_locking:true};

return match;

});

if(!slotTxn.committed)
return res.json({error:"MATCH_FULL"});

/* ======================================================
STEP 4 — WALLET DEDUCTION
====================================================== */

let depositUsed = 0;
let winningsUsed = 0;

if(dep >= entryFee){

depositUsed = entryFee;
dep -= entryFee;

}else{

depositUsed = dep;
winningsUsed = entryFee - dep;

dep = 0;
win -= winningsUsed;

}

await walletRef.update({
deposited:dep,
winnings:win
});

/* ======================================================
STEP 5 — FINAL SAVE
====================================================== */

const publicMatchId = matchData.matchId || matchId;

await db.ref().update({

[`matches/upcoming/${matchId}/players/${uid}`]:{
ign,
depositUsed,
winningsUsed,
joinedAt:Date.now()
},

[`users/${uid}/myMatches/${matchId}`]:{
joinedAt:Date.now()
},

[`users/${uid}/ign`]:ign,

[`users/${uid}/transactions/${publicMatchId}_Join`]:{
transactionId:`${publicMatchId}_Join`,
type:"entry",
amount:-entryFee,
status:"success",
reason:"Match Joined",
timestamp:Date.now()
}

});

res.json({status:"SUCCESS"});

}catch(err){

console.error("JOIN ERROR:",err);
res.status(500).json({error:"SERVER_ERROR"});

}

});

/* ======================================================
ADMIN UPDATE MATCH
====================================================== */

app.post("/admin/update-match",verifyAdmin,async(req,res)=>{
const {matchKey,updates}=req.body;
await db.ref(`matches/${matchKey}`).update(updates);
res.json({status:"UPDATED"});
});

/* ======================================================
ADMIN DUPLICATE MATCH
====================================================== */

app.post("/admin/duplicate-match",verifyAdmin,async(req,res)=>{
const {matchKey,newMatchId}=req.body;

const snap=await db.ref(`matches/${matchKey}`).once("value");
if(!snap.exists()) return res.json({error:"NOT_FOUND"});

const match=snap.val();
delete match.players;
delete match.results;

match.matchId=newMatchId;
match.status="upcoming";
match.locked=false;
match.resultsCredited=false;
match.cancelledProcessed=false;

const newRef=db.ref("matches").push();
await newRef.set(match);

res.json({status:"DUPLICATED",matchKey:newRef.key});
});

/* ======================================================
ADMIN SET ROOM
====================================================== */

app.post("/admin/set-room",verifyAdmin,async(req,res)=>{
const {matchKey,roomId,roomPassword}=req.body;
await db.ref(`matches/${matchKey}`).update({
roomId,
roomPassword
});
res.json({status:"ROOM_UPDATED"});
});

/* ======================================================
ADMIN UPDATE STATUS
====================================================== */

app.post("/admin/update-status",verifyAdmin,async(req,res)=>{
const {matchKey,newStatus}=req.body;

await db.ref(`matches/${matchKey}/status`).set(newStatus);

if(newStatus==="cancelled"){
await cancelMatch(matchKey);
}

res.json({status:"UPDATED"});
});

/* ======================================================
CANCEL MATCH (REFUND) - ATOMIC & IDEMPOTENT
====================================================== */

async function cancelMatch(matchKey){

const matchRef = db.ref(`matches/${matchKey}`);

const lockTxn = await matchRef.transaction(match => {
if(!match) return match;
if(match.cancelledProcessed) return match;
match.cancelledProcessed = true;
return match;
});

if(!lockTxn.committed || !lockTxn.snapshot.val()) return;

const match = lockTxn.snapshot.val();
const players = match.players||{};
const publicMatchId = match.matchId;

for(const uid in players){

const p = players[uid];

await db.ref(`users/${uid}/wallet/deposited`)
.transaction(v=>(Number(v)||0)+(Number(p.depositUsed)||0));

await db.ref(`users/${uid}/wallet/winnings`)
.transaction(v=>(Number(v)||0)+(Number(p.winningsUsed)||0));

const txnId=`${publicMatchId}_Refund`;

await db.ref(`users/${uid}/transactions/${txnId}`)
.set({
transactionId:txnId,
matchId:publicMatchId,
type:"Refund",
reason:"Match Cancelled",
amount:(Number(p.depositUsed)||0)+(Number(p.winningsUsed)||0),
status:"Success",
timestamp:Date.now()
});
}
}

/* ======================================================
ADMIN SUBMIT RESULTS - ATOMIC CREDIT CHECK
====================================================== */

app.post("/admin/submit-results",verifyAdmin,async(req,res)=>{

const {matchKey,results}=req.body;

const matchRef = db.ref(`matches/${matchKey}`);

const creditTxn = await matchRef.transaction(match => {
if(!match) return match;
if(match.resultsCredited) return; // abort - already credited
match.resultsCredited = true;
return match;
});

if(!creditTxn.committed) return res.json({error:"TRANSACTION_FAILED"});

const match = creditTxn.snapshot.val();
if(!match) return res.json({error:"NOT_FOUND"});

const players = match.players||{};
const publicMatchId = match.matchId;

for(const uid in results){

const {rank,kills}=results[uid];

const rankPrize=
Number(match.prizeDistribution?.[rank]||0);

const killPrize=
Number(match.perKill||0)*Number(kills||0);

const total=rankPrize+killPrize;

await db.ref(`users/${uid}/wallet/winnings`)
.transaction(v=>(Number(v)||0)+total);

const txnId=`${publicMatchId}_Winnings`;

await db.ref(`users/${uid}/transactions/${txnId}`)
.set({
transactionId:txnId,
matchId:publicMatchId,
type:"Match Winnings",
reason:"Match Winnings",
amount:total,
rank,
kills,
rankPrize,
killPrize,
status:"Success",
timestamp:Date.now()
});
}

await matchRef.update({
results
});

res.json({status:"RESULTS_SUBMITTED"});
});

/* ======================================================
ADMIN UPDATE RESULTS NO CREDIT
====================================================== */

app.post("/admin/update-results-only",verifyAdmin,async(req,res)=>{
const {matchKey,results}=req.body;
await db.ref(`matches/${matchKey}`)
.update({
results,
status:"completed"
});
res.json({status:"UPDATED_ONLY"});
});

/* ======================================================
ADMIN DELETE RESULTS
====================================================== */

app.post("/admin/delete-results",verifyAdmin,async(req,res)=>{
const {matchKey}=req.body;

const snap=
await db.ref(`matches/${matchKey}/resultsCredited`)
.once("value");

if(snap.val())
return res.json({error:"Cannot delete credited results"});

await db.ref(`matches/${matchKey}/results`)
.remove();

res.json({status:"DELETED"});
});

/* ======================================================
USER HOME - GET DASHBOARD DATA (OPTIMIZED NO CACHE)
====================================================== */

app.get("/api/home", verifyFirebaseToken, async (req, res) => {
  try {

    const uid = req.uid;

    /* FETCH ALL DATA IN PARALLEL */
    const [
      userSnap,
      announcementSnap,
      bannerSnap,
      gameModesSnap
    ] = await Promise.all([
      db.ref(`users/${uid}`).once("value"),
      db.ref("announcements").orderByChild("timestamp").limitToLast(1).once("value"),
      db.ref("banners").once("value"),
      db.ref("gameModes").once("value")
    ]);

    const user = userSnap.val();

    if (!user) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    if (user.status === "banned") {
      return res.json({
        banned: true,
        reason: user.banReason || "Account suspended"
      });
    }

    /* WALLET */
    const wallet = user.wallet || {};
    const deposited = Number(wallet.deposited || 0);
    const winnings = Number(wallet.winnings || 0);

    /* ANNOUNCEMENT */
    let announcement = "Welcome to ElitePros!";

    if (announcementSnap.val()) {
      const val = Object.values(announcementSnap.val())[0];
      if (val && val.active !== false) {
        announcement = val.message || val.title || announcement;
      }
    }

    /* BANNERS */
    let banners = [];

    const bannersRaw = bannerSnap.val();

    if (bannersRaw) {
      banners = Object.values(bannersRaw)
        .filter(b => b.active !== false)
        .sort((a, b) => (a.order || 999) - (b.order || 999));
    }

    /* GAME MODES */
    let gameModes = [];

    const modesRaw = gameModesSnap.val();

    if (modesRaw) {
      gameModes = Object.values(modesRaw)
        .filter(m => m.active !== false)
        .sort((a, b) => (a.order || 999) - (b.order || 999));
    }

    res.json({
      banned: false,
      user: {
        username: user.username || user.email?.split("@")[0] || "Player"
      },
      wallet: {
        deposited,
        winnings,
        total: deposited + winnings
      },
      announcement,
      banners,
      gameModes
    });

  } catch (err) {
    console.error("HOME API ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET LEADERBOARD (UPDATED)
====================================================== */

app.get("/api/leaderboard", async (req, res) => {
  try {

    const filter = req.query.filter || "today";

    if (!["today", "weekly", "monthly", "allTime"].includes(filter)) {
      return res.status(400).json({ error: "INVALID_FILTER" });
    }

    const leaderboardRef = db.ref(`leaderboards/${filter}`);

    const playersSnap = await leaderboardRef
      .child("players")
      .orderByChild("earnings")
      .limitToLast(10)
      .once("value");

    if (!playersSnap.exists()) {
      return res.json({ players: [] });
    }

    const rewardsSnap = await leaderboardRef
      .child("rewards")
      .once("value");

    const rewards = rewardsSnap.val() || {};

    const players = [];

    playersSnap.forEach(child => {
      players.push({
        id: child.key,
        ...child.val()
      });
    });

    // highest first
    players.sort((a, b) => (b.earnings || 0) - (a.earnings || 0));

    // attach reward based on rank
    const formatted = players.map((player, index) => {
      const rank = index + 1;
      return {
        id: player.id,
        name: player.username || "Player",
        earnings: player.earnings || 0,
        rank,
        reward: Number(rewards[rank] || 0)
      };
    });

    res.json({ players: formatted });

  } catch (err) {
    console.error("LEADERBOARD ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET ACCOUNT STATS
====================================================== */

app.get("/api/account", verifyFirebaseToken, async (req, res) => {

  try {

    const uid = req.uid;

    const myMatchesSnap = await db.ref(`users/${uid}/myMatches`).once("value");

    const totalMatches = myMatchesSnap.exists()
      ? Object.keys(myMatchesSnap.val()).length
      : 0;

    const transactionsSnap = await db.ref(`users/${uid}/transactions`).once("value");

    let lifetimeWinnings = 0;

    if (transactionsSnap.exists()) {
      Object.values(transactionsSnap.val()).forEach(tx => {
        if (tx.type === "Match Winnings") {
          lifetimeWinnings += Number(tx.amount || 0);
        }
      });
    }

    res.json({
      totalMatches,
      lifetimeWinnings
    });

  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR" });
  }

});

/* ======================================================
USER PROFILE - GET PROFILE
====================================================== */

app.get("/api/profile", verifyFirebaseToken, async (req, res) => {
  try {

    const uid = req.uid;

    const userSnap = await db.ref(`users/${uid}`).once("value");

    if (!userSnap.exists()) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const user = userSnap.val();

    res.json({
      name: user.name || "",
      username: user.username || "",
      email: user.email || "",
      phone: user.phone || "",
      bio: user.bio || ""
    });

  } catch (err) {
    console.error("PROFILE GET ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER PROFILE - UPDATE BIO
====================================================== */

app.post("/api/profile/update-bio", verifyFirebaseToken, async (req, res) => {
  try {

    const uid = req.uid;
    const bio = (req.body.bio || "").trim();

    if (bio.length > 30) {
      return res.status(400).json({ error: "BIO_TOO_LONG" });
    }

    await db.ref(`users/${uid}/bio`).set(bio);

    res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("PROFILE UPDATE ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ================= START ================= */

app.listen(
process.env.PORT||3000,
()=>console.log("Server running securely")
);

/* ======================================================
AUTH - RESOLVE IDENTIFIER (USERNAME / PHONE / EMAIL)
====================================================== */

app.post("/api/auth/resolve-identifier", async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier)
      return res.status(400).json({ error: "IDENTIFIER_REQUIRED" });

    const value = identifier.trim();

    // If email format → return directly
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.json({ email: value });
    }

    const usersRef = db.ref("users");
    let snapshot;

    // Phone format (India 10-digit)
    if (/^[6-9]\d{9}$/.test(value)) {
      snapshot = await usersRef
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .once("value");
    } else {
      // Username
      snapshot = await usersRef
        .orderByChild("username")
        .equalTo(value)
        .limitToFirst(1)
        .once("value");
    }

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const userData = Object.values(snapshot.val())[0];

    res.json({ email: userData.email });

  } catch (err) {
    console.error("RESOLVE IDENTIFIER ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
AUTH - CREATE SESSION (VERIFY TOKEN & BAN CHECK)
====================================================== */

app.post("/api/auth/session", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;

    const snap = await db.ref(`users/${uid}`).once("value");

    if (!snap.exists()) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const user = snap.val();

    if (user.status === "banned") {
      return res.json({
        banned: true,
        reason: user.banReason || "Account suspended"
      });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
AUTH - FORGOT PASSWORD (RESOLVE EMAIL)
====================================================== */

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier)
      return res.status(400).json({ error: "IDENTIFIER_REQUIRED" });

    const value = identifier.trim();

    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.json({ email: value });
    }

    const usersRef = db.ref("users");
    let snapshot;

    if (/^[6-9]\d{9}$/.test(value)) {
      snapshot = await usersRef
        .orderByChild("phone")
        .equalTo(value)
        .limitToFirst(1)
        .once("value");
    } else {
      snapshot = await usersRef
        .orderByChild("username")
        .equalTo(value)
        .limitToFirst(1)
        .once("value");
    }

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const userData = Object.values(snapshot.val())[0];

    res.json({ email: userData.email });

  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET WALLET (BALANCE + LAST 5 TRANSACTIONS)
READS FROM: users/{uid}/wallet
READS FROM: users/{uid}/transactions
====================================================== */

app.get("/api/wallet", verifyFirebaseToken, async (req, res) => {
  try {

    const uid = req.uid;

    const userSnap = await db.ref(`users/${uid}`).once("value");

    if (!userSnap.exists()) {
      return res.status(404).json({ error: "USER_NOT_FOUND" });
    }

    const user = userSnap.val();
    const wallet = user.wallet || { deposited: 0, winnings: 0 };

    const deposited = Number(wallet.deposited || 0);
    const winnings = Number(wallet.winnings || 0);
    const total = deposited + winnings;

    // Fetch last 5 transactions only
    const transactionsSnap = await db
      .ref(`users/${uid}/transactions`)
      .orderByChild("timestamp")
      .limitToLast(5)
      .once("value");

    let transactions = [];

    if (transactionsSnap.exists()) {
      transactions = Object.entries(transactionsSnap.val())
        .map(([id, data]) => ({
          id,
          ...data
        }))
        .filter(t => typeof t.timestamp === "number")
        .sort((a, b) => b.timestamp - a.timestamp);
    }

    res.json({
      balance: total, // ← IMPORTANT (for join page)
      wallet: {
        deposited,
        winnings,
        total
      },
      transactions
    });

  } catch (err) {
    console.error("WALLET API ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET DEPOSIT OPTIONS
====================================================== */

app.get("/api/deposit-options", verifyFirebaseToken, async (req, res) => {
  try {
    const snap = await db.ref("settings/depositAmounts").once("value");

    if (!snap.exists()) {
      return res.json({ amounts: [100, 250, 500, 1000] });
    }

    const raw = snap.val();

    const amounts = Object.values(raw)
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);

    res.json({ amounts });

  } catch (err) {
    console.error("DEPOSIT OPTIONS ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET WALLET TRANSACTIONS (PAGINATED)
READS FROM: users/{uid}/transactions
====================================================== */

app.get("/api/wallet/transactions", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;

    const limit = parseInt(req.query.limit) || 10;
    const lastTimestamp = req.query.lastTimestamp
      ? Number(req.query.lastTimestamp)
      : null;

    let query = db
      .ref(`users/${uid}/transactions`)
      .orderByChild("timestamp");

    // If loading next page, fetch older than lastTimestamp
    if (lastTimestamp) {
      query = query.endBefore(lastTimestamp);
    }

    const snap = await query.limitToLast(limit).once("value");

    if (!snap.exists()) {
      return res.json({
        transactions: [],
        hasMore: false,
        nextCursor: null
      });
    }

    const data = snap.val();

    // Convert object to array
    let transactions = Object.keys(data)
      .map(key => ({
        id: key,
        ...data[key]
      }))
      // remove bad or missing timestamps
      .filter(t => typeof t.timestamp === "number")
      // newest first
      .sort((a, b) => b.timestamp - a.timestamp);

    const hasMore = transactions.length === limit;

    const nextCursor =
      transactions.length > 0
        ? transactions[transactions.length - 1].timestamp
        : null;

    res.json({
      transactions,
      hasMore,
      nextCursor
    });

  } catch (err) {
    console.error("TRANSACTIONS API ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ======================================================
USER - GET MATCHES (TOURNAMENT LIST OPTIMIZED)
Reads from:
matches/{status}/{matchId}

Card data stored in:
matchDetails
====================================================== */

app.get("/api/matches", verifyFirebaseToken, async (req,res)=>{

try{

/* USER UID */

const uid = req.uid;

/* QUERY PARAMETERS */

const status = req.query.status || "upcoming";
const limit = parseInt(req.query.limit) || 10;
const cursor = req.query.cursor ? Number(req.query.cursor) : null;

/* VALIDATE STATUS */

if(!["upcoming","ongoing","completed"].includes(status)){
return res.status(400).json({error:"INVALID_STATUS"});
}

/* FIREBASE QUERY */

let query = db
.ref(`matches/${status}`)
.orderByChild("matchDetails/schedule");

/* PAGINATION */

if(cursor){
query = query.endBefore(cursor);
}

/* FETCH MATCHES */

const snap = await query
.limitToLast(limit)
.once("value");

/* EMPTY RESULT */

if(!snap.exists()){
return res.json({
matches:[],
hasMore:false
});
}

const matches=[];

/* BUILD RESPONSE */

snap.forEach(child=>{

const match = child.val();

/* MATCH CARD DATA */

const d = match.matchDetails || {};

/* PLAYER INFO */

const players = match.players || {};

matches.push({

id: child.key,

/* MATCH CARD FIELDS */

title: d.title || "Match",

banner: d.banner || "",

matchId: d.matchId || child.key,

schedule: d.schedule || 0,

prizePool: Number(d.prizePool || 0),

perKill: Number(d.perKill || 0),

entryFee: Number(d.entryFee || 0),

type: d.type || "",

platform: d.platform || "",

map: d.map || "",

gameMode: d.gameMode || "",

slots: Number(d.slots || 0),

/* JOIN INFO */

joinedCount: Number(match.joinedCount || 0),

isJoined: !!players[uid]

});

});

/* SORT BY SCHEDULE */

matches.sort((a,b)=>b.schedule-a.schedule);

/* RESPONSE */

res.json({

matches,

hasMore: matches.length===limit,

nextCursor:
matches.length>0
?matches[matches.length-1].schedule
:null

});

}catch(err){

console.error("MATCHES API ERROR:",err);

res.status(500).json({error:"SERVER_ERROR"});

}

});

/* ======================================================
USER - GET MATCH DETAILS
Reads full match data for join page
====================================================== */

app.get(
"/api/match/:matchId",
verifyFirebaseToken,
async(req,res)=>{

try{

const uid = req.uid;

const {matchId} = req.params;

/* FETCH MATCH */

const snap = await db
.ref(`matches/upcoming/${matchId}`)
.once("value");

/* NOT FOUND */

if(!snap.exists()){
return res.status(404).json({error:"MATCH_NOT_FOUND"});
}

const match = snap.val();

/* MATCH DETAILS */

const d = match.matchDetails || {};

const players = match.players || {};

/* RESPONSE */

res.json({

id: matchId,

title: d.title || "Match",

banner: d.banner || "",

matchId: d.matchId || matchId,

schedule: d.schedule || 0,

prizePool: Number(d.prizePool || 0),

perKill: Number(d.perKill || 0),

entryFee: Number(d.entryFee || 0),

type: d.type || "",

platform: d.platform || "",

map: d.map || "",

gameMode: d.gameMode || "",

slots: Number(d.slots || 0),

joinedCount: Number(match.joinedCount || 0),

isJoined: !!players[uid]

});

}catch(err){

console.error("MATCH DETAILS ERROR:",err);

res.status(500).json({error:"SERVER_ERROR"});

}

});

app.get("/ping",(req,res)=>{
res.send("alive");
});


app.get("/test-zapupi", async (req,res)=>{

try{

const r = await fetch("https://api.zapupi.com");

res.json({status:r.status});

}catch(e){

console.log(e);
res.json({error:"cannot reach zapupi"});

}

});
