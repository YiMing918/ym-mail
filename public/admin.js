/* 佲的邮箱 · 管理后台前端（/admin，独立登录，调 /api/admin/* 接口） */
'use strict';
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function toast(msg){ var el=$('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(function(){ el.classList.remove('show'); },2400); }
function copy(t){ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){toast('已复制：'+t);},function(){toast(t);}); } else toast(t); }
async function api(path, opts){
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  var data = null;
  try { data = await res.json(); } catch(e) { /* 非 JSON */ }
  if(!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
  return data;
}
function armDelete(btn, label){
  if(!btn.classList.contains('arm')){
    btn.classList.add('arm'); btn.textContent='再点一次确认删';
    setTimeout(function(){ btn.classList.remove('arm'); btn.textContent=label; }, 2600);
    return false;
  }
  return true;
}

var POLICIES = [];
var INVITES = [];
var BLACKLIST = [];
var BANNED = [];
var SETTINGS = {};
var polOpen = 0;
var polGrpOpen = { '0:u': true };

/* ── 政策渲染（与预览 C 同一套交互） ── */
function limitLabel(l){ return l==='self' ? '0 个' : (l==='inf' ? '不限量' : l+' 个'); }
function limitOpts(cur, vals){ return vals.map(function(v){ return '<option value="'+v+'"'+(cur===v?' selected':'')+'>'+limitLabel(v)+'</option>'; }).join(''); }
function grpSummary(p, grp){
  var open = grp==='u' ? p.uopen : p.gopen;
  if(!open) return '关';
  function l(v){ return v==='self' ? '0 个' : (v==='inf' ? '不限量' : '≤'+v); }
  var custom = grp==='u' ? p.ucustom : p.gcustom;
  var random = grp==='u' ? p.urandom : p.grandom;
  var del = grp==='u' ? p.udel : p.gdel;
  var refund = grp==='u' ? p.urefund : p.grefund;
  var minlen = grp==='u' ? p.uminlen : p.gminlen;
  return '自定义 ' + l(custom) + ' · 随机 ' + l(random) + (minlen && minlen!=='1' ? ' · 前缀≥'+minlen+' 位' : '') + ' · ' + (del ? (refund ? '可删·返额' : '可删·不返额') : '不可删');
}
function lenOpts(cur){
  return ['1','2','3','4','5','6','8'].map(function(v){
    return '<option value="'+v+'"'+(cur===v?' selected':'')+'>'+(v==='1' ? '不限（1 位起）' : '至少 '+v+' 位')+'</option>';
  }).join('');
}
function limCtrl(i, grp, kind, val){
  var k = grp + kind;
  var inf = val === 'inf';
  var num = inf ? '' : (val === 'self' ? '0' : val);
  var inp = 'background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--ink);padding:7px 9px;font-size:13px;width:74px;margin-left:auto;text-align:center';
  return '<input type="number" min="0" max="1000" step="1" inputmode="numeric" placeholder="个数" data-pol="'+i+'" data-k="'+k+'" data-lim="1" value="'+num+'"'+(inf?' disabled':'')+' style="'+inp+'">'
    + '<span style="font-size:12.5px;color:var(--ink2)">不限量</span><button class="switch'+(inf?' on':'')+'" data-pol="'+i+'" data-k="'+k+'inf" style="flex:none"></button>';
}
function polRow(i, p, grp){
  var open = grp==='u' ? p.uopen : p.gopen;
  var custom = grp==='u' ? p.ucustom : p.gcustom;
  var random = grp==='u' ? p.urandom : p.grandom;
  var del = grp==='u' ? p.udel : p.gdel;
  var refund = grp==='u' ? p.urefund : p.grefund;
  var customVals = grp==='u' ? ['self','1','3','5','10','inf'] : ['0','1','2','3','5','inf'];
  var randomVals = grp==='u' ? ['self','1','3','5','inf'] : ['0','1','2','3','5','inf'];
  var minlen = grp==='u' ? p.uminlen : p.gminlen;
  var sel = 'background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--ink);padding:7px 9px;font-size:13px;margin-left:auto';
  var key = i + ':' + grp, isOpen = !!polGrpOpen[key];
  var head = '<button class="polhead'+(isOpen?' open':'')+'" data-grphead="'+key+'" style="padding:11px 0 9px"><span class="inf"><span style="font-size:13.5px;font-weight:700;color:var(--ink2)">'+(grp==='u'?'注册用户':'没注册的游客')+'</span><span class="sm" style="display:block">'+esc(grpSummary(p, grp))+'</span></span><span class="chev">▾</span></button>';
  if(!isOpen) return head;
  return head + '<div style="padding-bottom:6px">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:2px"><span style="font-size:13.5px">可以用这个域名</span><button class="switch'+(open?' on':'')+'" data-pol="'+i+'" data-k="'+grp+'open" style="margin-left:auto"></button></div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:13.5px">自定义前缀能建几个</span>'+limCtrl(i, grp, 'custom', custom)+'</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:13.5px">随机地址能用几个</span>'+limCtrl(i, grp, 'random', random)+'</div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:13.5px">自定义前缀最少几位</span><input type="number" min="1" max="32" step="1" inputmode="numeric" data-pol="'+i+'" data-k="'+grp+'minlen" data-limlen="1" value="'+(minlen || '1')+'" style="'+sel+'width:74px;text-align:center"></div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:13.5px">能删掉重建吗</span><button class="switch'+(del?' on':'')+'" data-pol="'+i+'" data-k="'+grp+'del" style="margin-left:auto"></button></div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span style="font-size:13.5px">删掉后返还额度吗</span><button class="switch'+(refund?' on':'')+'" data-pol="'+i+'" data-k="'+grp+'refund" style="margin-left:auto"></button></div></div>';
}
function polSummary(p){
  function seg(open, custom, random){
    if(!open) return '关';
    function l(v){ return v==='self' ? '0 个' : (v==='inf' ? '不限量' : '≤'+v); }
    return '自定义 ' + l(custom) + ' · 随机 ' + l(random);
  }
  return '注册：' + seg(p.uopen, p.ucustom, p.urandom) + '　|　游客：' + seg(p.gopen, p.gcustom, p.grandom);
}
function renderPolicies(){
  $('policyList').innerHTML = POLICIES.map(function(p, i){
    var open = polOpen===i;
    return '<div style="border-top:1px solid var(--line)">'
      + '<button class="polhead'+(open?' open':'')+'" data-polhead="'+i+'"><span class="inf"><span class="nm">'+esc(p.dom)+'</span>'+(p.is_main?'<span class="maintag">主域名</span>':'')+'<span class="sm" style="display:block">'+esc(polSummary(p))+'</span></span><span class="chev">▾</span></button>'
      + (open ? '<div class="polbody">' + polRow(i, p, 'u') + polRow(i, p, 'g')
        + (!p.is_main ? '<div style="margin-top:10px;text-align:right"><button data-setmain="'+i+'" style="background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 14px;font-size:12.5px;margin-right:8px">设为主域名</button><button class="del" data-deldom="'+i+'" style="background:var(--panel2);border:1px solid var(--line);color:#ff9c9c;border-radius:8px;padding:8px 14px;font-size:12.5px">删除此域名</button></div>' : '<div style="margin-top:10px;color:var(--ink3);font-size:12px">主域名不能删除</div>')
        + '</div>' : '')
      + '</div>';
  }).join('');
  var first = $('policyList').firstElementChild; if(first) first.style.borderTop='none';
}
function limNum(v){ return v==='inf' ? -1 : (v==='self' ? 0 : Number(v)); }
async function savePolicy(i){
  var p = POLICIES[i];
  await api('/api/admin/policies/'+encodeURIComponent(p.dom), { method:'POST', body:{
    u_open: p.uopen, u_custom: limNum(p.ucustom), u_random: limNum(p.urandom),
    u_del: p.udel, u_refund: p.urefund, u_minlen: Number(p.uminlen),
    g_open: p.gopen, g_custom: limNum(p.gcustom), g_random: limNum(p.grandom),
    g_del: p.gdel, g_refund: p.grefund, g_minlen: Number(p.gminlen),
  }});
}
$('policyList').addEventListener('click', async function(e){
  var mainBtn = e.target.closest ? e.target.closest('[data-setmain]') : null;
  if(mainBtn){
    var mi2 = Number(mainBtn.getAttribute('data-setmain'));
    var md2 = POLICIES[mi2].dom;
    try {
      await api('/api/admin/domains/'+encodeURIComponent(md2)+'/main', { method:'POST' });
      POLICIES.forEach(function(pp, jj){ pp.is_main = jj===mi2; });
      renderPolicies();
      toast('主域名已改为 '+md2);
    } catch(err2){ toast(err2.message); }
    return;
  }
  var delBtn = e.target.closest ? e.target.closest('[data-deldom]') : null;
  if(delBtn){
    if(!armDelete(delBtn, '删除此域名')) return;
    var di = Number(delBtn.getAttribute('data-deldom'));
    var gone = POLICIES[di].dom;
    try {
      await api('/api/admin/domains/'+encodeURIComponent(gone), { method:'DELETE' });
      POLICIES.splice(di, 1);
      polOpen = 0; polGrpOpen = { '0:u': true };
      renderPolicies();
      toast('已停用域名：'+gone+'（存量邮件保留在库里）');
    } catch(err2){ toast(err2.message); }
    return;
  }
  var ghead = e.target.closest ? e.target.closest('[data-grphead]') : null;
  if(ghead){
    var gk = ghead.getAttribute('data-grphead');
    polGrpOpen[gk] = !polGrpOpen[gk];
    renderPolicies();
    return;
  }
  var head = e.target.closest ? e.target.closest('[data-polhead]') : null;
  if(head){
    var hi = Number(head.getAttribute('data-polhead'));
    polOpen = polOpen===hi ? -1 : hi;
    renderPolicies();
    return;
  }
  var i = e.target.getAttribute && e.target.getAttribute('data-pol');
  var k = e.target.getAttribute && e.target.getAttribute('data-k');
  if(k && k.slice(-3)==='inf' && i!==null && i!==undefined){
    var bk = k.slice(0, -3), bi = Number(i), prev = POLICIES[bi][bk];
    POLICIES[bi][bk] = prev==='inf' ? '1' : 'inf';
    try { await savePolicy(bi); renderPolicies(); toast(POLICIES[bi].dom + ' 已更新'); }
    catch(err2){ POLICIES[bi][bk] = prev; renderPolicies(); toast(err2.message); }
    return;
  }
  if(i===null||i===undefined||['uopen','gopen','udel','gdel','urefund','grefund'].indexOf(k)===-1) return;
  POLICIES[Number(i)][k] = !POLICIES[Number(i)][k];
  try { await savePolicy(Number(i)); renderPolicies(); toast(POLICIES[Number(i)].dom + ' 已更新'); }
  catch(err2){ POLICIES[Number(i)][k] = !POLICIES[Number(i)][k]; renderPolicies(); toast(err2.message); }
});
$('policyList').addEventListener('change', async function(e){
  var i = e.target.getAttribute && e.target.getAttribute('data-pol');
  var k = e.target.getAttribute && e.target.getAttribute('data-k');
  if(['ucustom','urandom','gcustom','grandom','uminlen','gminlen'].indexOf(k)===-1) return;
  if(e.target.getAttribute('data-lim')){
    var raw = String(e.target.value).trim();
    if(!/^\d+$/.test(raw) || Number(raw) > 1000){ toast('个数填 0 到 1000 的整数，或者打开旁边的「不限量」'); loadAdmin(); return; }
    e.target.value = String(Number(raw));
  }
  if(e.target.getAttribute('data-limlen')){
    var rawL = String(e.target.value).trim();
    if(!/^\d+$/.test(rawL) || Number(rawL) < 1 || Number(rawL) > 32){ toast('前缀最少位数填 1 到 32 的整数'); loadAdmin(); return; }
    e.target.value = String(Number(rawL));
  }
  POLICIES[Number(i)][k] = e.target.value;
  var names = { ucustom:'注册用户·自定义前缀', urandom:'注册用户·随机地址', gcustom:'游客·自定义前缀', grandom:'游客·随机地址', uminlen:'注册用户·前缀最少位数', gminlen:'游客·前缀最少位数' };
  try {
    await savePolicy(Number(i));
    renderPolicies();
    if(k==='uminlen' || k==='gminlen') toast(POLICIES[Number(i)].dom + ' ' + names[k] + '：' + (e.target.value==='1' ? '不限' : '至少 '+e.target.value+' 位'));
    else toast(POLICIES[Number(i)].dom + ' ' + names[k] + '：' + limitLabel(e.target.value));
  } catch(err2){ toast(err2.message); loadAdmin(); }
});
$('addDomain').addEventListener('click', async function(){
  var d = $('newDomInput').value.trim().toLowerCase();
  if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)){ toast('域名格式不对，如 mail.example.com'); return; }
  try {
    await api('/api/admin/domains', { method:'POST', body:{ domain: d } });
    $('newDomInput').value = '';
    await loadAdmin();
    polOpen = POLICIES.length - 1; renderPolicies();
    toast('已添加 '+d+'（默认只开放给注册用户，游客关着）');
  } catch(e){ toast(e.message); }
});

/* ── 全站开关 / 清理 ── */
async function saveSettings(patch, okMsg){
  try { await api('/api/admin/settings', { method:'POST', body: patch }); if(okMsg) toast(okMsg); }
  catch(e){ toast(e.message); loadAdmin(); }
}
$('regMode').addEventListener('change', function(){
  $('inviteRow').classList.toggle('hidden', $('regMode').value!=='invite');
  saveSettings({ reg_mode: $('regMode').value }, '注册方式：' + $('regMode').selectedOptions[0].textContent);
});
$('swGuestMode').addEventListener('click', function(){
  var on = !this.classList.contains('on');
  this.classList.toggle('on', on);
  saveSettings({ guest_mode: on }, on ? '游客模式已开启：不注册也能用' : '游客模式已关闭：前台会提示必须登录');
});
$('swAdminTg').addEventListener('click', function(){
  var on = !this.classList.contains('on');
  this.classList.toggle('on', on);
  saveSettings({ admin_tg_push: on }, on ? 'TG 推送已开启' : 'TG 推送已关闭');
});
$('swRefBonus').addEventListener('click', function(){
  var on = !this.classList.contains('on');
  this.classList.toggle('on', on);
  saveSettings({ ref_bonus: on }, on ? '邀请奖励已开启：邀请一人给专属额度' : '邀请奖励已关闭：邀请也不给额度了');
});
$('refBonusN').addEventListener('change', function(){
  var v = String(this.value).trim();
  if(!/^\d+$/.test(v) || Number(v) > 1000){ toast('邀请奖励个数填 0 到 1000 的整数'); loadAdmin(); return; }
  saveSettings({ ref_bonus_n: Number(v) }, '邀请一人给 ' + v + ' 个专属额度');
});
$('mailFrom').addEventListener('change', function(){
  saveSettings({ mail_from: this.value.trim() }, '系统发件地址已保存');
});
function bindDayInput(id, key, label, zeroText){
  $(id).addEventListener('change', function(){
    var v = String(this.value).trim();
    if(!/^\d+$/.test(v) || Number(v) > 3650){ toast('天数填 0 到 3650 的整数'); loadAdmin(); return; }
    var patch = {}; patch[key] = Number(v);
    saveSettings(patch, label + (Number(v)===0 ? zeroText : v + ' 天'));
  });
}

/* ── 邀请码 ── */
function invSummary(){
  var avail = INVITES.filter(function(x){ return x.left!==0; }).length;
  var hasInf = INVITES.some(function(x){ return x.left===-1; });
  var times = INVITES.reduce(function(s, x){ return s + (x.left>0 ? x.left : 0); }, 0);
  return avail + ' 个码可用' + (hasInf ? '（含不限次）' : ' · 还能用 ' + times + ' 次');
}
function renderInvites(){
  $('invCount').textContent = invSummary();
  $('invList').innerHTML = INVITES.length ? INVITES.map(function(x, i){
    return '<div class="row"><div><span style="font-family:ui-monospace,monospace;letter-spacing:1px;font-size:14.5px">'+esc(x.code)+'</span><div class="sub">'+(x.left===-1 ? '不限次' : (x.left===0 ? '已用完' : '还剩 '+x.left+' 次'))+'</div></div><button class="del" data-invcopy="'+i+'">复制</button><button class="del" data-invrm="'+i+'">作废</button></div>';
  }).join('') : '<div class="row"><div style="color:var(--ink3)">暂无邀请码，生成一个发给朋友</div></div>';
}
$('invHead').addEventListener('click', function(){ $('invDetail').classList.toggle('hidden'); this.classList.toggle('open'); });
$('invInf').addEventListener('click', function(){
  this.classList.toggle('on');
  $('invUses').disabled = this.classList.contains('on');
});
$('genInvite').addEventListener('click', async function(){
  try {
    var uses;
    if($('invInf').classList.contains('on')) uses = -1;
    else {
      var v = String($('invUses').value).trim();
      if(!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 1000){ toast('每个码的次数填 1 到 1000，或打开「不限次」'); return; }
      uses = Number(v);
    }
    var nv = String($('invNum').value).trim();
    if(!/^\d+$/.test(nv) || Number(nv) < 1 || Number(nv) > 50){ toast('一次生成 1 到 50 个'); return; }
    var r = await api('/api/admin/invites', { method:'POST', body:{ uses: uses, count: Number(nv) } });
    (r.codes || [r.code]).forEach(function(c){ INVITES.unshift({ code: c, left: uses }); });
    renderInvites();
    toast('已生成 ' + (r.codes ? r.codes.length : 1) + ' 个随机邀请码（每个' + (uses===-1 ? '不限次' : '可用 '+uses+' 次') + '），互不相同，点复制发给朋友');
  } catch(e){ toast(e.message); }
});
$('copyInvites').addEventListener('click', function(){
  var avail = INVITES.filter(function(x){ return x.left!==0; }).map(function(x){ return x.code; });
  if(!avail.length){ toast('没有可用的邀请码，先生成'); return; }
  copy(avail.join('\n'));
  toast('已复制 ' + avail.length + ' 个可用邀请码');
});
$('invList').addEventListener('click', async function(e){
  var ci = e.target.getAttribute && e.target.getAttribute('data-invcopy');
  if(ci!==null && ci!==undefined){ copy(INVITES[Number(ci)].code); return; }
  var ri = e.target.getAttribute && e.target.getAttribute('data-invrm');
  if(ri===null || ri===undefined) return;
  var x = INVITES[Number(ri)];
  try {
    await api('/api/admin/invites/'+encodeURIComponent(x.code), { method:'DELETE' });
    INVITES.splice(Number(ri), 1);
    renderInvites(); toast('已作废：'+x.code);
  } catch(err2){ toast(err2.message); }
});

/* ── 防护 ── */
function renderGuard(){
  $('blCount').textContent = BLACKLIST.length + ' 条';
  $('banCount').textContent = BANNED.length + ' 个';
  $('blList').innerHTML = BLACKLIST.length ? BLACKLIST.map(function(x, i){
    return '<div class="row"><div>'+esc(x)+'</div><button class="del" data-blrm="'+i+'">移除</button></div>';
  }).join('') : '<div class="row"><div style="color:var(--ink3)">暂无</div></div>';
  $('banList').innerHTML = BANNED.length ? BANNED.map(function(x, i){
    return '<div class="row"><div>'+esc(x)+'</div><button class="del" data-banrm="'+i+'">解封</button></div>';
  }).join('') : '<div class="row"><div style="color:var(--ink3)">暂无</div></div>';
}
$('blHead').addEventListener('click', function(){ $('blDetail').classList.toggle('hidden'); this.classList.toggle('open'); });
$('banHead').addEventListener('click', function(){ $('banDetail').classList.toggle('hidden'); this.classList.toggle('open'); });
$('blAdd').addEventListener('click', async function(){
  var v = $('blInput').value.trim().toLowerCase();
  if(!v || (v.indexOf('@')===-1)){ toast('填发件人邮箱，或 @域名 表示整个域名'); return; }
  try {
    await api('/api/admin/blacklist', { method:'POST', body:{ pattern: v } });
    BLACKLIST.push(v); $('blInput').value=''; renderGuard(); toast('已拉黑：'+v);
  } catch(e){ toast(e.message); }
});
$('banAdd').addEventListener('click', async function(){
  var v = $('banInput').value.trim().toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)){ toast('填完整的邮箱地址'); return; }
  try {
    await api('/api/admin/banned', { method:'POST', body:{ address: v } });
    BANNED.push(v); $('banInput').value=''; renderGuard(); toast('已封禁：'+v);
  } catch(e){ toast(e.message); }
});
$('blList').addEventListener('click', async function(e){
  var i = e.target.getAttribute && e.target.getAttribute('data-blrm');
  if(i===null||i===undefined) return;
  var x = BLACKLIST[Number(i)];
  try {
    await api('/api/admin/blacklist/'+encodeURIComponent(x), { method:'DELETE' });
    BLACKLIST.splice(Number(i), 1); renderGuard(); toast('已移除：'+x);
  } catch(err2){ toast(err2.message); }
});
$('banList').addEventListener('click', async function(e){
  var i = e.target.getAttribute && e.target.getAttribute('data-banrm');
  if(i===null||i===undefined) return;
  var x = BANNED[Number(i)];
  try {
    await api('/api/admin/banned/'+encodeURIComponent(x), { method:'DELETE' });
    BANNED.splice(Number(i), 1); renderGuard(); toast('已解封：'+x);
  } catch(err2){ toast(err2.message); }
});

/* ── 登录 / 数据加载 ── */
async function loadAdmin(){
  var data = await api('/api/admin/bootstrap');
  POLICIES = data.policies; INVITES = data.invites;
  BLACKLIST = data.blacklist; BANNED = data.banned; SETTINGS = data.settings;
  $('statUsers').textContent = data.stats.users;
  $('statAddresses').textContent = data.stats.addresses;
  $('statToday').textContent = data.stats.todayMails;
  $('regMode').value = SETTINGS.reg_mode;
  $('inviteRow').classList.toggle('hidden', SETTINGS.reg_mode!=='invite');
  $('swGuestMode').classList.toggle('on', !!SETTINGS.guest_mode);
  $('swAdminTg').classList.toggle('on', !!SETTINGS.admin_tg_push);
  $('swRefBonus').classList.toggle('on', SETTINGS.ref_bonus !== false);
  $('refBonusN').value = SETTINGS.ref_bonus_n == null ? 3 : SETTINGS.ref_bonus_n;
  $('mailFrom').value = SETTINGS.mail_from || '';
  $('inGuestDays').value = SETTINGS.guest_days;
  $('inUserCap').value = SETTINGS.user_cap;
  $('inIdleDays').value = SETTINGS.idle_days;
  renderPolicies(); renderInvites(); renderGuard();
}
function showAdmin(){
  $('adminLoginView').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  window.scrollTo(0,0);
}
$('admGo').addEventListener('click', async function(){
  try {
    await api('/api/admin/login', { method:'POST', body:{ username: $('admUser').value.trim(), password: $('admPw').value } });
    await loadAdmin(); showAdmin();
    toast('欢迎回来，站长');
  } catch(e){ toast(e.message); }
});
$('admOut').addEventListener('click', async function(){
  try { await api('/api/admin/logout', { method:'POST', body:{} }); } catch(e) { /* 忽略 */ }
  $('adminView').classList.add('hidden');
  $('adminLoginView').classList.remove('hidden');
});
$('admFront').addEventListener('click', function(){ window.location.href = '/'; });
$('admBack').addEventListener('click', function(){ window.location.href = '/'; });
bindDayInput('inGuestDays', 'guest_days', '游客邮件保留：', '不自动删');
bindDayInput('inUserCap', 'user_cap', '注册用户最长保留：', '不限');
bindDayInput('inIdleDays', 'idle_days', '随机地址闲置清理：', '不清理');

/* 已有管理员会话时直接进后台 */
loadAdmin().then(showAdmin).catch(function(){ /* 未登录，停在登录页 */ });
