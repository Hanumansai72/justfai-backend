const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test'; process.env.ENABLE_REDIS = 'false'; process.env.JWT_SECRET = 'route-test-secret';
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
const express = require('express');
const Interest = require('../src/models/EarlyInterest.model');
const { unsubscribeUrl } = require('../src/services/interestUnsubscribe.service');
let revoked=0, origin, server;
Interest.updateOne=async()=>{revoked++;return {modifiedCount:1};};
const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use('/api/early-interest',require('../src/routes/interestPreferencesRoutes'));
before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+server.address().port;});
after(()=>new Promise(resolve=>server.close(resolve)));
test('removed campaign endpoints are unavailable',async()=>{
 for(const [path,method] of [['/website-update','GET'],['/website-update/test','POST'],['/website-update/approve','POST'],['/website-update/process','GET']]) {
  assert.equal((await fetch(origin+'/api/early-interest'+path,{method})).status,404);
 }
});
test('a link scanner cannot unsubscribe someone with GET, while explicit POST can',async()=>{
 const token=new URL(unsubscribeUrl('507f1f77bcf86cd799439011')).searchParams.get('token');
 const before=revoked;
 const page=await fetch(origin+'/api/early-interest/unsubscribe?token='+encodeURIComponent(token));assert.equal(page.status,200);assert.equal(revoked,before);assert.match(await page.text(),/<form method="post"/);
 const invalid=await fetch(origin+'/api/early-interest/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'invalid'})});assert.equal(invalid.status,400);assert.equal(revoked,before);
 const submitted=await fetch(origin+'/api/early-interest/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});assert.equal(submitted.status,200);assert.equal(revoked,before+1);
});
