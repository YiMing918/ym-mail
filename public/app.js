/* 佲的邮箱 · 正式版前端（调真实 API）
   省额度：首屏只打 /api/bootstrap；30 秒轮询只打 /api/check 问有没有新信；
   列表只拉摘要，正文点开才拉详情。 */
'use strict';

/* ── 基础 ── */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function toast(msg){ var el=$('toast'); el.textContent=msg; el.classList.add('show'); setTimeout(function(){ el.classList.remove('show'); },2400); }
function copy(t){ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){toast('已复制：'+t);},function(){toast(t);}); } else toast(t); }
var COLORS = ['#e8590c','#1971c2','#2f9e44','#9c36b5','#e64980','#0c8599','#f08c00','#5f3dc4'];
function colorOf(name){ var s=0; for(var i=0;i<name.length;i++) s+=name.charCodeAt(i); return COLORS[s%COLORS.length]; }
function initialOf(name){ return /[一-龥]/.test(name[0]) ? name[0] : name[0].toUpperCase(); }
function ago(t){ var m=Math.floor((Date.now()-t)/60000); if(m<1) return '刚刚'; if(m<60) return m+' 分钟前'; var h=Math.floor(m/60); if(h<24) return h+' 小时前'; return Math.floor(h/24)+' 天前'; }
function clock(t){ var d=new Date(t), n=new Date(); return d.toDateString()===n.toDateString() ? d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : (d.getMonth()+1)+'/'+d.getDate(); }
function domOf(addr){ var i = String(addr||'').lastIndexOf('@'); return i<0 ? '' : String(addr).slice(i+1); }
function rndPrefix(){
  var words=['mail','hi','go','me','vip','lab','box','one','sky','pro'];
  var chars='abcdefghjkmnpqrstuvwxyz23456789', suf='';
  for(var i=0;i<4;i++) suf+=chars[Math.floor(Math.random()*chars.length)];
  return words[Math.floor(Math.random()*words.length)]+'-'+suf;
}
async function api(path, opts){
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  var data = null;
  try { data = await res.json(); } catch(e) { /* 非 JSON 响应 */ }
  if(!res.ok || !data || data.ok === false){
    throw new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
  }
  return data;
}

/* ── 状态 ── */
var S = null;              // bootstrap 数据
var MAILS = [], MAIL_TOTAL = 0;
var CODES = [];
var curAddr = 'all', filter = 'all', view = 'inbox', query = '';
var selectMode = false, selected = {};
var cardAddr = '', cardTemp = false;
var knownLatest = 0;

function mode(){ return S ? S.mode : 'guest'; }
function policies(){ return S ? S.policies : []; }
function policyOf(dom){ for(var i=0;i<policies().length;i++) if(policies()[i].dom===dom) return policies()[i]; return null; }
function guestDoms(){ return policies().filter(function(p){ return p.gopen; }).map(function(p){ return p.dom; }); }
function mainDomain(){ var p = policies().find(function(x){ return x.is_main; }); return p ? p.dom : (policies()[0] ? policies()[0].dom : ''); }
function myAddrs(){ return S ? S.addresses : []; }
function addrRow(a){ return myAddrs().find(function(x){ return x.address===a; }); }
function poolUsed(dom, kind){ var q = (S && S.quota && S.quota[dom]) || { c:0, r:0 }; return kind==='c' ? q.c : q.r; }

/* ── 渲染 ── */
function show(viewName){
  ['frontView','authView'].forEach(function(v){ $(v).classList.toggle('hidden', v!==viewName); });
  window.scrollTo(0,0);
}
function renderModeBar(){
  var st = S.settings;
  if(mode()==='guest'){
    $('modeBar').className = 'modebar';
    $('modeBar').innerHTML = st.guest_mode
      ? '👋 <b>游客模式</b>：不用注册就能收信，邮箱是临时的（邮件保留 '+st.guest_days+' 天）。注册后邮箱长期是你的、还能发信。'
      : '🔒 <b>游客模式已关闭</b>：站长设置必须登录后才能用。点右上角「登录 / 注册」。';
  } else {
    $('modeBar').className = 'modebar ok';
    $('modeBar').innerHTML = '✅ 已登录：<b>'+esc(S.user.username)+'</b> · 你的邮箱只有你能看，别人知道地址也进不来。';
  }
  $('btnAuth').classList.toggle('hidden', mode()!=='guest');
  $('btnLogout').classList.toggle('hidden', mode()!=='user');
  $('composeLock').classList.toggle('hidden', mode()!=='guest');
  $('composeForm').classList.toggle('hidden', mode()==='guest');
  $('mySettings').style.display = mode()==='guest' ? 'none' : '';
  $('guestSettingsNote').classList.toggle('hidden', mode()!=='guest');
}
function renderSwitcher(){
  var A = myAddrs();
  var totalAll = A.reduce(function(s,a){ return s+a.total; }, 0);
  var unreadAll = A.reduce(function(s,a){ return s+a.unread; }, 0);
  if(curAddr==='all'){
    $('boxName').textContent = mode()==='guest' ? '全部临时邮箱' : '全部邮箱';
    $('boxSub').textContent = '共 ' + totalAll + ' 封 · 未读 ' + unreadAll;
  } else {
    var row = addrRow(curAddr);
    $('boxName').textContent = curAddr;
    $('boxSub').textContent = row ? (row.total + ' 封 · 未读 ' + row.unread) : '0 封 · 未读 0';
  }
  var items = [{a:'all'}].concat(A.map(function(a){ return {a:a.address, row:a}; }));
  $('sheetList').innerHTML = items.map(function(x){
    var label = x.a==='all' ? (mode()==='guest' ? '全部临时邮箱' : '全部邮箱') : x.a;
    var n = x.a==='all' ? totalAll : x.row.total;
    var u = x.a==='all' ? unreadAll : x.row.unread;
    return '<button class="boxrow" data-pick="'+esc(x.a)+'">'
      + '<span class="avatar" style="background:'+(x.a==='all' ? '#3a3a44' : colorOf(x.a))+'">'+(x.a==='all' ? '✉' : esc(initialOf(x.a.split('@')[0])))+'</span>'
      + '<span class="inf"><span class="a">'+esc(label)+(x.row && x.row.main?'<span class="maintag">主邮箱</span>':'')+'</span><span class="b">'+n+' 封 · 未读 '+u+'</span></span>'
      + (curAddr===x.a ? '<span class="ck">✓</span>' : '') + '</button>';
  }).join('');
  $('cFrom').innerHTML = A.map(function(a){ return '<option value="'+esc(a.address)+'">佲 &lt;'+esc(a.address)+'&gt;</option>'; }).join('');
  renderAddrList(); renderCard();
}
function renderCard(){
  $('curAddr').textContent = cardAddr || '—';
  $('saveAlias').classList.toggle('hidden', !cardTemp);
}
function canDeleteAddr(a){
  if(a.main) return false;
  var p = policyOf(domOf(a.address));
  if(!p) return true;
  return mode()==='guest' ? p.gdel : p.udel;
}
function renderAddrList(){
  var idle = S.settings.idle_days;
  $('addrList').innerHTML = myAddrs().map(function(a){
    var right = a.main ? '<span class="val">不可删</span>'
      : (canDeleteAddr(a) ? '<button class="del" data-deladdr="'+esc(a.address)+'">删除</button>' : '<span class="val">不可删（站长设置）</span>');
    var isRnd = a.kind==='random';
    var sub = a.total+' 封邮件 · @'+esc(domOf(a.address)) + (isRnd && idle>0 ? ' · 无新信 '+idle+' 天自动删' : '');
    return '<div class="row"><div>'+esc(a.address)+(a.main?'<span class="maintag">主邮箱</span>':'')+(isRnd?'<span class="maintag" style="background:rgba(76,195,138,.12);border-color:rgba(76,195,138,.4);color:#7ddba8">随机</span>':'')+'<div class="sub">'+sub+'</div></div>' + right + '</div>';
  }).join('');
  var doms = mode()==='guest' ? guestDoms() : policies().map(function(p){ return p.dom; });
  var prevDom = $('newDomSel').value;
  $('newDomSel').innerHTML = doms.map(function(d){ return '<option value="'+esc(d)+'">@'+esc(d)+'</option>'; }).join('');
  if(doms.indexOf(prevDom)>-1) $('newDomSel').value = prevDom;
  updateLenHint();
}
function updateLenHint(){
  var el = $('lenHint'); if(!el) return;
  var pol = policyOf($('newDomSel').value);
  if(!pol || mode()!=='user'){ el.textContent = ''; return; }
  el.textContent = pol.uminlen && pol.uminlen!=='1'
    ? '提示：'+pol.dom+' 的自定义前缀要求至少 '+pol.uminlen+' 位（站长设置，短前缀是稀缺资源）'
    : '提示：'+pol.dom+' 的自定义前缀长度不限';
}
function renderList(){
  var unreadAll = myAddrs().reduce(function(s,a){ return s+a.unread; }, 0);
  $('unreadBdg').textContent = unreadAll; $('unreadBdg').style.display = unreadAll ? '' : 'none';
  $('statVal').textContent = '共 ' + myAddrs().reduce(function(s,a){ return s+a.total; }, 0) + ' 封 · 未读 ' + unreadAll;
  $('loadMore').classList.toggle('hidden', !(MAIL_TOTAL > MAILS.length));
  if(selectMode) renderSelBar();
  if(!MAILS.length){
    $('mailList').innerHTML = query
      ? '<div class="empty"><span class="big">🔍</span>没搜到「'+esc(query)+'」相关的邮件<br>换个词试试，或清空搜索</div>'
      : (filter!=='all' || view==='sent'
        ? '<div class="empty"><span class="big">📭</span>这个分类下暂时没有邮件</div>'
        : '<div class="empty"><span class="big">📭</span>这里还没有邮件<br>把上面的地址填到要注册的网站，验证码马上就到</div>');
    return;
  }
  $('mailList').innerHTML = MAILS.map(function(m){
    var sel = !!selected[m.id];
    return '<button class="mail'+(m.read?'':' unread')+(selectMode && sel ? ' sel':'')+'" '+(selectMode ? 'data-sel="'+m.id+'"' : 'data-open="'+m.id+'"')+'>'
      + (selectMode ? '<span class="ckbox'+(sel?' on':'')+'">'+(sel?'✓':'')+'</span>' : (m.read ? '<span style="width:8px;flex:none"></span>' : '<span class="dot"></span>'))
      + '<span class="avatar" style="background:'+colorOf(m.from)+'">'+esc(initialOf(m.from))+'</span>'
      + '<span class="body"><span class="r1"><span class="from">'+esc(m.from)+'</span><span class="time">'+clock(m.t)+'</span></span>'
      + '<span class="subj">'+esc(m.subj || '（无主题）')+'</span>'
      + '<span class="snip">'+esc(m.snip)+'</span>'
      + '<span class="meta"><span class="toaddr">'+esc(m.to)+'</span>'
      + (m.otp ? '<span class="otpchip">🔑 '+esc(m.otp)+'</span>' : '')
      + (m.att ? '<span class="toaddr">📎 '+m.att+'</span>' : '')
      + '<span class="star'+(m.star?' on':'')+'" style="margin-left:auto">'+(m.star?'★':'☆')+'</span></span></span></button>';
  }).join('');
}
function renderCodes(){
  var codes = CODES.filter(function(m){ return curAddr==='all' || m.to===curAddr; });
  $('codeList').innerHTML = codes.length ? codes.map(function(m){
    return '<div class="codecard"><div class="src"><span class="avatar" style="width:30px;height:30px;border-radius:9px;font-size:13px;background:'+colorOf(m.from)+'">'+esc(initialOf(m.from))+'</span><b style="color:var(--ink)">'+esc(m.from)+'</b><span>· '+esc(m.to)+'</span></div>'
      + '<div class="code">'+esc(m.otp)+'</div>'
      + '<div class="foot"><span>'+ago(m.t)+'收到</span><button class="copy" data-copy="'+esc(m.otp)+'">复制</button></div></div>';
  }).join('') : '<div class="empty"><span class="big">🔑</span>这个邮箱下还没有验证码<br>收到带验证码的邮件会自动出现在这里</div>';
}
function renderQuota(){
  function lim(v){ return v==='self' ? '0' : (v==='inf' ? '∞' : v); }
  var parts = [];
  policies().forEach(function(p){
    if(mode()==='guest'){
      if(!p.gopen) return;
      parts.push('<b>'+esc(p.dom)+'</b> 随机 '+poolUsed(p.dom,'r')+'/'+lim(p.grandom)+' · 自定义 '+poolUsed(p.dom,'c')+'/'+lim(p.gcustom));
    } else {
      if(!p.uopen) return;
      parts.push('<b>'+esc(p.dom)+'</b> 自定义 '+poolUsed(p.dom,'c')+'/'+lim(p.ucustom)+' · 随机 '+poolUsed(p.dom,'r')+'/'+lim(p.urandom));
    }
  });
  if(mode()!=='guest' && S.user && Number(S.user.bonus) > 0) parts.push('专属额度 <b>+'+Number(S.user.bonus)+'</b>');
  $('quotaStrip').innerHTML = (mode()==='guest' ? '游客额度　' : '我的额度　') + (parts.length ? parts.join('　|　') : '暂无可用域名');
}
function renderSettings(){
  if(mode()!=='user' || !S.user) return;
  $('swTg').classList.toggle('on', !!S.user.tg_push);
  $('swForward').classList.toggle('on', !!S.user.forward_backup);
  $('tgChatId').value = S.user.tg_chat_id || '';
  $('fwdEmail').textContent = S.user.email;
  var refOn = !S.settings || S.settings.ref_bonus !== false;
  $('inviteGroup').classList.toggle('hidden', !refOn);
  if(refOn){
    $('myInviteCode').textContent = S.user.invite_code || '—';
    $('inviteStats').textContent = '已邀请 ' + Number(S.user.invited || 0) + ' 人 · 专属额度 ' + Number(S.user.bonus || 0) + ' 个';
  }
  document.querySelectorAll('.refBonusN').forEach(function(el){ el.textContent = (S.settings && S.settings.ref_bonus_n != null) ? S.settings.ref_bonus_n : 3; });
  renderMyRet();
}
function renderMyRet(){
  if(mode()!=='user') return;
  var cap = S.settings.user_cap;
  var opts = [1,7,15,30,90,180,365,0];
  var allowed = opts.filter(function(d){ return cap===0 || (d!==0 && d<=cap); });
  var mine = Number(S.user.retention_days);
  $('myRet').innerHTML = allowed.map(function(d){
    return '<button class="retchip'+(mine===d?' on':'')+'" data-d="'+d+'">'+(d===0?'永不删':(d===365?'1 年':d+' 天'))+'</button>';
  }).join('');
  $('myRetNote').textContent = '超过天数自动删除，星标不删 · 站长上限：' + (cap===0 ? '不限' : cap+' 天');
}
function renderAll(){
  document.querySelectorAll('.refBonusN').forEach(function(el){ el.textContent = (S.settings && S.settings.ref_bonus_n != null) ? S.settings.ref_bonus_n : 3; });
  renderModeBar(); renderQuota(); renderSwitcher(); renderList(); renderCodes(); renderSettings();
}

/* ── 数据加载 ── */
async function boot(){
  var data = await api('/api/bootstrap');
  S = data;
  if(!policies().length){
    $('modeBar').className = 'modebar';
    $('modeBar').innerHTML = '🛠 <b>站点刚部署</b>：站长还没有在后台添加邮箱域名，暂时收不了信。';
  }
  if(curAddr!=='all' && !addrRow(curAddr)) curAddr = 'all';
  if(!cardAddr || (cardAddr && !cardTemp && !addrRow(cardAddr))) cardAddr = myAddrs()[0] ? myAddrs()[0].address : '';
  knownLatest = data.latest || 0;
  if(data.mode==='guest' && data.settings.guest_mode && !data.guestBlocked){
    MAILS = data.mails || []; MAIL_TOTAL = data.total || 0; CODES = data.codes || [];
    if(!myAddrs().length && guestDoms().length){
      // 游客第一次来：自动给一个临时地址（与预览「打开就有地址」的体验一致）
      try {
        var r = await api('/api/guest/address', { method:'POST', body:{} });
        cardAddr = r.address; curAddr = r.address;
        await boot();
        return;
      } catch(e) { /* 额度满等情况就保持空列表 */ }
    }
  } else {
    MAILS = data.mails || []; MAIL_TOTAL = data.total || 0; CODES = data.codes || [];
  }
  renderAll();
  refreshList(true); // 按当前 scope/filter 重新对齐列表
}
async function softRefresh(){
  var data = await api('/api/bootstrap');
  S = data;
  knownLatest = data.latest || knownLatest;
  if(curAddr!=='all' && !addrRow(curAddr)) curAddr = 'all';
  CODES = data.codes || [];
  renderAll();
  refreshList(true);
}
async function refreshList(reset){
  if(!S) return;
  var offset = reset ? 0 : MAILS.length;
  var qs = '?scope='+encodeURIComponent(curAddr)+'&filter='+filter+'&view='+view+'&q='+encodeURIComponent(query)+'&limit=30&offset='+offset;
  try {
    var data = await api('/api/mails'+qs);
    MAIL_TOTAL = data.total;
    MAILS = reset ? data.mails : MAILS.concat(data.mails);
    renderList(); renderSwitcher();
  } catch(e) { toast(e.message); }
}
async function refreshCodes(){
  try {
    var data = await api('/api/codes?scope='+encodeURIComponent(curAddr));
    CODES = data.codes; renderCodes();
  } catch(e) { /* 轮询路径静默 */ }
}
/* 30 秒轻量轮询：只问有没有新信，有才刷新 */
setInterval(async function(){
  if(!S || document.hidden) return;
  if(!$('frontView') || $('frontView').classList.contains('hidden')) return;
  try {
    var data = await api('/api/check');
    if(data.latest && data.latest > knownLatest){
      knownLatest = data.latest;
      softRefresh();
    }
  } catch(e) { /* 网络抖动下轮再试 */ }
}, 30000);

/* ── 详情 ── */
function armDelete(btn, label){
  if(!btn.classList.contains('arm')){
    btn.classList.add('arm'); btn.textContent='再点一次确认删';
    setTimeout(function(){ btn.classList.remove('arm'); btn.textContent=label; }, 2600);
    return false;
  }
  return true;
}
async function openDetail(id){
  var data;
  try { data = await api('/api/mails/'+id); } catch(e){ toast(e.message); return; }
  var m = data.mail;
  var html = '<div class="topbar"><button class="back" id="dBack">‹ 返回</button><div class="acts"><button id="dStar">'+(m.star?'★ 已星标':'☆ 星标')+'</button><button id="dDel">删除</button></div></div>'
    + '<h2>'+esc(m.subj || '（无主题）')+'</h2>'
    + '<div class="meta">发件人：'+esc(m.from)+' &lt;'+esc(m.fromAddr)+'&gt;<br>收件人：'+esc(m.to)+'<br>时间：'+new Date(m.t).toLocaleString('zh-CN')+'</div>'
    + (m.otp ? '<div class="otpBig"><span class="c">'+esc(m.otp)+'</span><button data-copy="'+esc(m.otp)+'">一键复制</button></div>' : '')
    + (m.html ? '<div id="dHtmlBox"></div>' : '<div class="text">'+esc(m.text)+'</div>')
    + m.atts.map(function(a, i){
        return '<div class="attrow">📎 '+esc(a.filename)+'（'+Math.max(1, Math.round(a.size/1024))+' KB）'
          + (a.stored
              ? '<button data-att="'+i+'">下载</button>'
              : '<span style="margin-left:auto;color:var(--ink3)">过大未保存</span>')
          + '</div>';
      }).join('');
  $('detailView').innerHTML = html;
  $('detailView').classList.remove('hidden');
  if(m.html){
    var ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', '');
    ifr.style.cssText = 'width:100%;border:none;background:#fff;border-radius:12px;min-height:300px';
    ifr.srcdoc = m.html;
    $('dHtmlBox').appendChild(ifr);
  }
  // 打开即已读：本地同步状态
  MAILS.forEach(function(x){ if(x.id===id) x.read = true; });
  renderList();
  $('dBack').addEventListener('click', closeDetail);
  $('dStar').addEventListener('click', async function(){
    try {
      var r = await api('/api/mails/'+id+'/star', { method:'POST', body:{ starred: !m.star } });
      m.star = r.starred;
      MAILS.forEach(function(x){ if(x.id===id) x.star = m.star; });
      openDetailSoft(id, m);
      renderList();
    } catch(e){ toast(e.message); }
  });
  $('dDel').addEventListener('click', async function(){
    if(!armDelete(this, '删除')) return;
    try {
      await api('/api/mails/'+id, { method:'DELETE' });
      closeDetail(); softRefresh(); toast('这封邮件已删除');
    } catch(e){ toast(e.message); }
  });
  var cb = $('detailView').querySelector('[data-copy]');
  if(cb) cb.addEventListener('click', function(){ copy(m.otp); });
  $('detailView').querySelectorAll('[data-att]').forEach(function(ab){
    ab.addEventListener('click', function(){
      window.open('/api/mails/'+id+'/att/'+ab.getAttribute('data-att'), '_blank');
    });
  });
}
function openDetailSoft(id, m){
  var b = $('dStar');
  if(b) b.textContent = m.star ? '★ 已星标' : '☆ 星标';
}
function closeDetail(){ $('detailView').classList.add('hidden'); }

/* ── 多选删除 ── */
function renderSelBar(){
  var n = Object.keys(selected).length;
  $('selCount').textContent = '已选 ' + n + ' 封';
  var allSel = MAILS.length > 0 && MAILS.every(function(m){ return selected[m.id]; });
  $('selAll').textContent = allSel ? '取消全选' : '全选';
}
function resetSelDel(){ var db = $('selDel'); db.classList.remove('arm'); db.textContent = '删除所选'; }
function enterSel(){
  selectMode = true; selected = {};
  resetSelDel();
  $('selBar').classList.remove('hidden');
  $('selBtn').textContent = '取消';
  renderList();
}
function exitSel(){
  if(!selectMode) return;
  selectMode = false; selected = {};
  resetSelDel();
  $('selBar').classList.add('hidden');
  $('selBtn').textContent = '选择';
  renderList();
}
$('selBtn').addEventListener('click', function(){ selectMode ? exitSel() : enterSel(); });
$('selExit').addEventListener('click', exitSel);
$('selAll').addEventListener('click', function(){
  var allSel = MAILS.length > 0 && MAILS.every(function(m){ return selected[m.id]; });
  if(allSel) MAILS.forEach(function(m){ delete selected[m.id]; });
  else MAILS.forEach(function(m){ selected[m.id] = true; });
  renderList();
});
$('selDel').addEventListener('click', async function(){
  var ids = Object.keys(selected).map(Number);
  if(!ids.length){ toast('先勾选要删的邮件'); return; }
  if(!armDelete(this, '删除所选')) return;
  try {
    await api('/api/mails/batch-delete', { method:'POST', body:{ ids: ids } });
    exitSel(); softRefresh();
    toast('已删除 ' + ids.length + ' 封邮件');
  } catch(e){ toast(e.message); }
});

/* ── 前台事件 ── */
$('btnAuth').addEventListener('click', function(){ show('authView'); });
$('btnLogout').addEventListener('click', async function(){
  try { await api('/api/auth/logout', { method:'POST', body:{} }); } catch(e) { /* 忽略 */ }
  curAddr = 'all'; cardAddr = ''; cardTemp = false; filter = 'all'; view = 'inbox'; query=''; $('q').value='';
  await boot();
  toast('已退出，回到游客模式');
});
$('authBack').addEventListener('click', function(){ show('frontView'); });

var authMode = 'login';
function setAuthMode(m){
  authMode = m;
  $('tabLogin').classList.toggle('on', m==='login');
  $('tabReg').classList.toggle('on', m==='reg');
  $('regFields').classList.toggle('hidden', m!=='reg');
  $('authGo').textContent = m==='reg' ? '验证并注册' : '登录';
  if(m==='reg') syncRegFields();
}
function syncRegFields(){
  var inv = S && S.settings.reg_mode==='invite';
  $('codeRow').style.display = inv ? 'none' : 'flex';
  $('regNote').style.display = inv ? 'none' : '';
  $('inviteField').classList.toggle('hidden', !inv);
  $('refField').classList.toggle('hidden', !(S && S.settings.ref_bonus));
  $('authEmail').placeholder = inv ? '你的真实邮箱（备份转发用）' : '你的真实邮箱（收验证码用）';
}
$('tabLogin').addEventListener('click', function(){ setAuthMode('login'); });
$('tabReg').addEventListener('click', function(){
  if(S && S.settings.reg_mode==='off'){ toast('站长已关闭注册，暂时注册不了'); return; }
  setAuthMode('reg');
});
var codeTimer = null;
$('sendCode').addEventListener('click', async function(){
  var em = $('authEmail').value.trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('先填一个正确的邮箱地址'); return; }
  var btn = this;
  try {
    await api('/api/auth/send-code', { method:'POST', body:{ email: em } });
    toast('验证码已发送到 '+em);
    var left = 60;
    btn.disabled = true; btn.textContent = left + ' 秒后重发';
    codeTimer = setInterval(function(){
      left--;
      if(left<=0){ clearInterval(codeTimer); btn.disabled = false; btn.textContent = '发送验证码'; }
      else btn.textContent = left + ' 秒后重发';
    }, 1000);
  } catch(e){ toast(e.message); }
});
$('authGo').addEventListener('click', async function(){
  var username = $('authUser').value.trim();
  var password = $('authPw').value;
  if(!username){ toast('填一下账号'); return; }
  if(!password){ toast('填一下密码'); return; }
  try {
    if(authMode==='reg'){
      if(S.settings.reg_mode==='off'){ toast('站长已关闭注册，暂时注册不了'); return; }
      var em = $('authEmail').value.trim();
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('注册要填真实邮箱'); return; }
      var payload = { username: username, password: password, email: em };
      var refIn = $('authRef').value.trim();
      if(refIn) payload.referrer = refIn;
      if(S.settings.reg_mode==='invite'){
        var codeIn = $('authInvite').value.trim();
        if(!codeIn){ toast('填一下站长给你的邀请码'); return; }
        payload.invite = codeIn;
      } else {
        if(!$('authCode').value.trim()){ toast('填一下邮箱里收到的验证码'); return; }
        payload.code = $('authCode').value.trim();
      }
      await api('/api/auth/register', { method:'POST', body: payload });
      curAddr = 'all'; cardAddr = ''; cardTemp = false;
      await boot(); show('frontView');
      toast('验证通过，注册成功');
    } else {
      await api('/api/auth/login', { method:'POST', body:{ username: username, password: password } });
      curAddr = 'all'; cardAddr = ''; cardTemp = false;
      await boot(); show('frontView');
      toast('登录成功');
    }
  } catch(e){ toast(e.message); }
});

$('boxBar').addEventListener('click', function(){ $('sheetWrap').classList.add('show'); });
$('sheetWrap').addEventListener('click', function(e){ if(e.target===$('sheetWrap')) $('sheetWrap').classList.remove('show'); });
$('sheetList').addEventListener('click', function(e){
  var el = e.target.closest ? e.target.closest('[data-pick]') : null;
  if(!el) return;
  exitSel();
  curAddr = el.getAttribute('data-pick');
  cardAddr = curAddr==='all' ? (myAddrs()[0] ? myAddrs()[0].address : '') : curAddr; cardTemp = false;
  $('sheetWrap').classList.remove('show');
  renderAll(); refreshList(true); refreshCodes();
});
$('sheetAdd').addEventListener('click', async function(){
  $('sheetWrap').classList.remove('show');
  if(mode()==='guest' && !(S.settings.guest_mode)){ toast('游客模式已关闭，请先登录'); show('authView'); return; }
  if(mode()==='guest'){
    try {
      var r = await api('/api/guest/address', { method:'POST', body:{} });
      curAddr = r.address; cardAddr = r.address; cardTemp = false;
      await softRefresh();
      toast('新的临时邮箱：'+r.address);
    } catch(e){ toast(e.message); }
    return;
  }
  document.querySelector('#tabbar button[data-page="pageSettings"]').click();
  setTimeout(function(){ $('newPrefix').focus(); }, 250);
});
$('genBtn').addEventListener('click', function(){
  if(mode()==='guest' && !(S.settings.guest_mode)){ toast('游客模式已关闭，请先登录'); show('authView'); return; }
  var dom;
  if(mode()==='guest'){
    var gd = guestDoms();
    if(!gd.length){ toast('暂时没有开放给游客的域名'); return; }
    dom = gd[Math.floor(Math.random()*gd.length)];
  } else {
    dom = curAddr==='all' ? mainDomain() : domOf(curAddr);
    if(!dom){ toast('还没有可用域名'); return; }
  }
  cardAddr = rndPrefix() + '@' + dom; cardTemp = true; renderCard();
  if(mode()==='guest') toast('临时地址已生成，注册后可点「存为邮箱」长期保存');
});
$('saveAlias').addEventListener('click', async function(){
  if(mode()==='guest'){ show('authView'); toast('注册后就能把地址存成你的邮箱'); return; }
  if(addrRow(cardAddr)){ toast('这个邮箱已经在列表里了'); cardTemp=false; renderCard(); return; }
  try {
    await api('/api/addresses', { method:'POST', body:{ address: cardAddr, kind:'random' } });
    curAddr = cardAddr; cardTemp = false;
    await softRefresh();
    toast('已存为邮箱：'+cardAddr);
  } catch(e){ toast(e.message); }
});
$('cpAddr').addEventListener('click', function(){ if(cardAddr) copy(cardAddr); });
var qTimer = null;
$('q').addEventListener('input', function(){
  clearTimeout(qTimer);
  qTimer = setTimeout(function(){ query = $('q').value.trim(); refreshList(true); }, 300);
});
$('readAll').addEventListener('click', async function(){
  try {
    await api('/api/mails/read-all', { method:'POST', body:{ scope: curAddr } });
    softRefresh(); toast('已全部标为已读');
  } catch(e){ toast(e.message); }
});
$('loadMore').addEventListener('click', function(){ refreshList(false); });
$('chips').addEventListener('click', function(e){
  var f = e.target.getAttribute && e.target.getAttribute('data-f'); if(!f) return;
  exitSel();
  if(f==='sent'){ view = 'sent'; filter = 'all'; }
  else { view = 'inbox'; filter = f; }
  var bs = $('chips').querySelectorAll('.chip');
  for(var i=0;i<bs.length;i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-f')===f);
  refreshList(true);
});
$('mailList').addEventListener('click', function(e){
  var s = e.target.closest ? e.target.closest('[data-sel]') : null;
  if(s){
    var id = Number(s.getAttribute('data-sel'));
    if(selected[id]) delete selected[id]; else selected[id] = true;
    renderList();
    return;
  }
  var el = e.target.closest ? e.target.closest('[data-open]') : null;
  if(el) openDetail(Number(el.getAttribute('data-open')));
});
$('codeList').addEventListener('click', function(e){
  var c = e.target.getAttribute && e.target.getAttribute('data-copy');
  if(c) copy(c);
});
document.querySelectorAll('#tabbar button').forEach(function(b){
  b.addEventListener('click', function(){
    exitSel();
    var p = b.getAttribute('data-page');
    ['pageInbox','pageCodes','pageCompose','pageSettings'].forEach(function(x){ $(x).classList.toggle('hidden', x!==p); });
    document.querySelectorAll('#tabbar button').forEach(function(x){ x.classList.toggle('on', x===b); });
    window.scrollTo(0,0);
    if(p==='pageCodes') refreshCodes();
  });
});
$('newDomSel').addEventListener('change', updateLenHint);
$('rndPrefix').addEventListener('click', function(){ $('newPrefix').value = rndPrefix().split('-')[0] + Math.floor(Math.random()*90+10); });
$('addAddr').addEventListener('click', async function(){
  var p = $('newPrefix').value.trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{0,30}$/.test(p)){ toast('前缀只能用小写字母、数字、点和横线'); return; }
  var dom = $('newDomSel').value;
  var pol = policyOf(dom);
  if(mode()==='user' && pol && !(S.user && S.user.is_owner)){
    if(!pol.uopen){ toast('这个域名没开放给注册用户（后台政策）'); return; }
    if(pol.ucustom!=='self' && pol.ucustom!=='inf'){
      if(poolUsed(dom, 'c') >= Number(pol.ucustom)){ toast('你在 '+dom+' 的自定义前缀已达上限 '+pol.ucustom+' 个（后台政策）'); return; }
    }
    if(pol.uminlen && p.length < Number(pol.uminlen)){ toast('前缀太短：'+dom+' 要求至少 '+pol.uminlen+' 位（站长设置）'); return; }
  }
  try {
    var r = await api('/api/addresses', { method:'POST', body:{ prefix: p, domain: dom, kind:'custom' } });
    $('newPrefix').value='';
    curAddr = r.address; cardAddr = r.address; cardTemp = false;
    await softRefresh();
    toast('已添加邮箱：'+r.address);
  } catch(e){ toast(e.message); }
});
$('addrList').addEventListener('click', async function(e){
  var a = e.target.getAttribute && e.target.getAttribute('data-deladdr');
  if(!a) return;
  if(!armDelete(e.target, '删除')) return;
  try {
    var r = await api('/api/addresses/'+encodeURIComponent(a), { method:'DELETE' });
    if(curAddr===a) curAddr = 'all';
    if(cardAddr===a) cardAddr = '';
    await softRefresh();
    toast(r.refund ? '已删除，额度已返还' : '已删除（按站长设置，额度不返还）');
  } catch(e){ toast(e.message); }
});
$('composeForm').addEventListener('submit', async function(e){
  e.preventDefault();
  var btn = $('cSend');
  btn.disabled = true; btn.textContent = '发送中…';
  try {
    await api('/api/send', { method:'POST', body:{ from: $('cFrom').value, to: $('cTo').value.trim(), subject: $('cSubject').value.trim(), text: $('cText').value } });
    $('cTo').value=''; $('cSubject').value=''; $('cText').value='';
    toast('发送成功（已存入「已发送」）');
    softRefresh();
  } catch(err2){ toast(err2.message); }
  btn.disabled = false; btn.textContent = '发送（经 Resend 免费通道）';
});
$('copyInvite').addEventListener('click', function(){
  if(S && S.user && S.user.invite_code) copy(S.user.invite_code);
});
$('swTg').addEventListener('click', async function(){
  var on = !this.classList.contains('on');
  try {
    await api('/api/me/settings', { method:'POST', body:{ tg_push: on } });
    S.user.tg_push = on; this.classList.toggle('on', on);
    toast(on ? 'TG 推送已开启' : 'TG 推送已关闭');
  } catch(e){ toast(e.message); }
});
$('swForward').addEventListener('click', async function(){
  var on = !this.classList.contains('on');
  try {
    await api('/api/me/settings', { method:'POST', body:{ forward_backup: on } });
    S.user.forward_backup = on; this.classList.toggle('on', on);
    toast(on ? '备份转发已开启（目标地址需先在 Cloudflare 验证，见说明）' : '备份转发已关闭');
  } catch(e){ toast(e.message); }
});
$('tgChatId').addEventListener('change', async function(){
  try {
    await api('/api/me/settings', { method:'POST', body:{ tg_chat_id: this.value.trim() } });
    S.user.tg_chat_id = this.value.trim();
    toast('Chat ID 已保存');
  } catch(e){ toast(e.message); }
});
$('myRet').addEventListener('click', async function(e){
  var d = e.target.getAttribute && e.target.getAttribute('data-d'); if(d===null||d===undefined) return;
  try {
    await api('/api/me/settings', { method:'POST', body:{ retention_days: Number(d) } });
    S.user.retention_days = Number(d); renderMyRet();
    toast('我的保留天数：' + (Number(d)===0 ? '永不删' : d+' 天'));
  } catch(e2){ toast(e2.message); }
});

/* ── 启动 ── */
boot().catch(function(e){
  $('modeBar').className = 'modebar';
  $('modeBar').innerHTML = '⚠️ 加载失败：'+esc(e.message)+'，下拉刷新页面再试。';
});
