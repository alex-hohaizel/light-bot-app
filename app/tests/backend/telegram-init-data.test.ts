import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {verifyTelegramInitData,verifyTelegramLoginData} from '../../server/telegram-init-data.ts';

const token = 'synthetic-test-token', now = 1794135600;
function signed(fields: Array<[string,string]>, key = token) {
  const params = new URLSearchParams(fields);
  const text = [...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = createHmac('sha256','WebAppData').update(key).digest();
  params.append('hash',createHmac('sha256',secret).update(text).digest('hex'));
  return params.toString();
}
const fields = (date=String(now), user:unknown={id:123456789,first_name:'Олена'}) =>
  [['auth_date',date],['query_id','synthetic-query'],['user',JSON.stringify(user)]] as Array<[string,string]>;
const verify = (raw:unknown) => verifyTelegramInitData(raw,token,{nowSeconds:now});

test('authenticated owner comes only from intact signed payload; token/bot scope matters',()=>{
  assert.deepEqual(verify(signed(fields())),{id:'123456789',firstName:'Олена',authDate:now});
  assert.throws(()=>verify(signed(fields(),'different-bot-token')));
  assert.throws(()=>verify(signed(fields()).replace('123456789','987654321')));
  assert.throws(()=>verify({user:{id:123456789}}));
});
test('expired, future and malformed signed auth_date are rejected before identity writes',()=>{
  for(const date of [String(now-3601),String(now+31),'NaN','Infinity','123abc','-1','']) assert.throws(()=>verify(signed(fields(date))));
  assert.equal(verify(signed(fields(String(now-3600)))).authDate,now-3600);
  assert.equal(verify(signed(fields(String(now+30)))).authDate,now+30);
});
test('signed duplicate fields, invalid identity, malformed hex and oversized data fail closed',()=>{
  assert.throws(()=>verify(signed([...fields(),['auth_date',String(now)]])));
  assert.throws(()=>verify(signed(fields())+'&hash='+'0'.repeat(64)));
  for(const user of [null,[],{id:'123',first_name:'Олена'},{id:0,first_name:'Олена'},{id:1.1,first_name:'Олена'},
    {id:1,first_name:''},{id:1,first_name:'Олена',is_bot:true}]) assert.throws(()=>verify(signed(fields(String(now),user))));
  for(const hash of ['ff','z'.repeat(64),'f'.repeat(63)]) assert.throws(()=>verify('auth_date='+now+'&hash='+hash));
  assert.throws(()=>verify('a'.repeat(16385)));
});

test('login widget and mobile exchange reject signed malformed/future/missing dates and invalid identity',()=>{
  const login = (patch:Record<string,unknown>={}) => {
    const data:Record<string,unknown>={id:123456789,first_name:'Олена',auth_date:now,...patch};
    const text=Object.keys(data).sort().map(k=>`${k}=${data[k]}`).join('\n');
    return {...data,hash:createHmac('sha256',createHash('sha256').update(token).digest()).update(text).digest('hex')};
  };
  assert.equal(verifyTelegramLoginData(login(),token,now).id,'123456789');
  for(const patch of [{auth_date:'NaN'},{auth_date:undefined},{auth_date:now+31},{auth_date:now-86401},
    {auth_date:'123abc'},{id:['123456789']},{id:1.5},{first_name:''},{id:0}])
    assert.throws(()=>verifyTelegramLoginData(login(patch),token,now));
  assert.throws(()=>verifyTelegramLoginData(login(),'wrong-bot',now));
  assert.equal(verifyTelegramLoginData(login({auth_date:now-86400}),token,now).authDate,now-86400);
});
