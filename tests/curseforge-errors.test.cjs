const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCurseForgeClient,httpFailure,networkFailure}=require('../src/panel/curseforge-client');
const key='private-test-key-never-display';
const response=(status,data={},retry='')=>({status,ok:status>=200&&status<300,json:async()=>data,headers:{get:()=>retry}});
test('Restricted mod downloads identify the author setting instead of blaming the key',async()=>{
  let calls=0;
  const client=createCurseForgeClient({getApiKey:()=>key,fetchImpl:async()=>++calls===1?response(403):response(200,{data:{name:"Mielon's The Sift",allowModDistribution:false}})});
  await assert.rejects(client.request('/mods/1691925/files/9519234/download-url'),error=>{
    assert.equal(error.code,'CF_DISTRIBUTION_DISABLED');assert.equal(error.httpStatus,403);
    assert.match(error.message,/Mielon's The Sift/);assert.match(error.message,/manualmente/);
    assert.match(error.message,/archivo 9519234/);assert.ok(!error.message.includes(key));return true;
  });assert.equal(calls,2);
});
test('Unknown download refusals do not assert a bad key or an unconfirmed author restriction',async()=>{
  const client=createCurseForgeClient({getApiKey:()=>key,fetchImpl:async url=>url.endsWith('download-url')?response(403):response(200,{data:{allowModDistribution:true}})});
  await assert.rejects(client.request('/mods/123/files/456/download-url'),error=>error.code==='CF_DOWNLOAD_FORBIDDEN'&&error.message.includes('No se ha podido confirmar'));
});
test('Invalid credentials and rate limits have different causes and actionable advice',()=>{
  const keyError=httpFailure(401,'buscar mods');assert.equal(keyError.code,'CF_API_KEY_REJECTED');
  const rate=httpFailure(429,'buscar mods',{retryAfter:'60'});assert.equal(rate.code,'CF_RATE_LIMIT');assert.match(rate.message,/60 segundos/);assert.match(rate.message,/HTTP 429/);
  assert.equal(httpFailure(503,'descargar mod').code,'CF_SERVICE_UNAVAILABLE');
  assert.equal(httpFailure(404,'consultar archivo').code,'CF_NOT_FOUND');
});
test('Network and timeout failures omit raw URLs, credentials and internal exception text',()=>{
  const cause=new Error('secret-url?key='+key);const error=networkFailure(cause,'descargar mod');
  assert.equal(error.code,'CF_CONNECTION_FAILED');assert.ok(!error.message.includes(key));
  cause.name='TimeoutError';assert.equal(networkFailure(cause,'descargar mod').code,'CF_TIMEOUT');
});
test('Missing keys and malformed responses receive explicit causes',async()=>{
  await assert.rejects(createCurseForgeClient({getApiKey:()=>''}).request('/mods/search?q=jei'),e=>e.code==='CF_API_KEY_MISSING');
  const client=createCurseForgeClient({getApiKey:()=>key,fetchImpl:async()=>({ok:true,json:async()=>{throw Error('raw-response '+key);}})});
  await assert.rejects(client.request('/mods/search?q=jei'),e=>e.code==='CF_INVALID_RESPONSE'&&!e.message.includes(key));
});
test('Successful catalog requests preserve API payloads and never probe download permissions',async()=>{
  let calls=0;const data=[{id:123,name:'JEI'}];
  const client=createCurseForgeClient({getApiKey:()=>key,fetchImpl:async(_url,options)=>{calls++;assert.equal(options.headers['x-api-key'],key);return response(200,{data});}});
  assert.equal(await client.request('/mods/search?q=jei'),data);assert.equal(calls,1);
});
