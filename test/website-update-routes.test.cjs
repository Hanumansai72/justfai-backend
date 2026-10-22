const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test'; process.env.ENABLE_REDIS = 'false'; process.env.JWT_SECRET = 'route-test-secret'; process.env.CRON_SECRET = 'isolated-scheduler-secret';
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
const express = require('express');
const auth = require('../src/middlewares/authMiddleware');
auth.protect = (req,res,next) => { const role = req.get('X-Test-Role'); if(!role) return res.status(401).json({success:false}); req.user={_id:'507f1f77bcf86cd799439011',role}; next(); };
const service = require('../src/services/websiteUpdateCampaign.service');
const Interest = require('../src/models/EarlyInterest.model');
const { unsubscribeUrl } = require('../src/services/interestUnsubscribe.service');
let calls=0, revoked=0, origin, server;
service.status=async()=>({state:'draft',eligibleCount:1});
service.sendTest=async()=>{calls++;return {sent:true,code:'SENT'};};
service.approve=async()=>{calls++;return {queued:1};};
service.drainWebsiteUpdates=async()=>{calls++;return 0;};
service.scheduleWebsiteUpdates=()=>{};
Interest.updateOne=async()=>{revoked++;return {modifiedCount:1};};
const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use('/api/early-interest',require('../src/routes/websiteUpdateRoutes'));
app.use((err,req,res,next)=>res.status(err.statusCode||500).json({success:false}));
before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+server.address().port;});
after(()=>new Promise(resolve=>server.close(resolve)));
test('unauthenticated and helper roles cannot invoke the campaign',async()=>{
 const before=calls;
 for(const path of ['/website-update','/website-update/test','/website-update/approve']){
  const method=path.endsWith('test')||path.endsWith('approve')?'POST':'GET';
  const unauth=await fetch(origin+'/api/early-interest'+path,{method});assert.equal(unauth.status,401);
  const helper=await fetch(origin+'/api/early-interest'+path,{method,headers:{'X-Test-Role':'HELPER'}});assert.equal(helper.status,403);
 }
 assert.equal(calls,before);
});
test('admin can preview and test through the guarded routes',async()=>{
 const preview=await fetch(origin+'/api/early-interest/website-update',{headers:{'X-Test-Role':'ADMIN'}});assert.equal(preview.status,200);
 const response=await fetch(origin+'/api/early-interest/website-update/test',{method:'POST',headers:{'X-Test-Role':'ADMIN'}});assert.equal(response.status,200);
});
test('scheduler requires its own valid bearer secret',async()=>{
 const url=origin+'/api/early-interest/website-update/process';
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{authorization:'Bearer incorrect'}})).status,401);
 assert.equal((await fetch(url,{headers:{authorization:'Bearer isolated-scheduler-secret'}})).status,200);
});
test('a link scanner cannot unsubscribe someone with GET, while explicit POST can',async()=>{
 const token=new URL(unsubscribeUrl('507f1f77bcf86cd799439011')).searchParams.get('token');
 const before=revoked;
 const page=await fetch(origin+'/api/early-interest/unsubscribe?token='+encodeURIComponent(token));assert.equal(page.status,200);assert.equal(revoked,before);assert.match(await page.text(),/<form method="post"/);
 const invalid=await fetch(origin+'/api/early-interest/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'invalid'})});assert.equal(invalid.status,400);assert.equal(revoked,before);
 const submitted=await fetch(origin+'/api/early-interest/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});assert.equal(submitted.status,200);assert.equal(revoked,before+1);
});
