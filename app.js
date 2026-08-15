(() => {
  'use strict';

  const TRIP_ID_STORAGE = 'kikuchi-live-trip-id';
  const config = window.KIKUCHI_CONFIG || {};
  const accessScreen = document.getElementById('access-screen');
  const accessMessage = document.getElementById('access-message');
  const accessForm = document.getElementById('access-form');
  const accessInput = document.getElementById('access-key-input');
  const accessError = document.getElementById('access-error');
  const syncState = document.getElementById('sync-state');
  const syncText = document.getElementById('sync-text');

  let db = null;
  let tripId = null;
  let realtimeChannel = null;
  let reloadTimer = null;
  const updateJobs = new Map();

  function setSync(label, state = '') {
    syncText.textContent = label;
    syncState.className = `sync-state${state ? ` ${state}` : ''}`;
  }

  function friendlyError(error, fallback = '연결 중 문제가 생겼어요.') {
    console.error(error);
    if (error && /invalid access key/i.test(error.message || '')) return '비밀 접근키가 올바르지 않아요.';
    if (error && /anonymous sign-ins/i.test(error.message || '')) return 'Supabase에서 익명 로그인을 먼저 허용해야 해요.';
    return fallback;
  }

  function showAccess(message, error = '') {
    accessMessage.textContent = message;
    accessError.textContent = error;
    accessForm.hidden = false;
    accessScreen.classList.remove('is-hidden');
    setTimeout(() => accessInput.focus(), 0);
  }

  function hideAccess() {
    accessScreen.classList.add('is-hidden');
    accessError.textContent = '';
  }

  function consumeFragmentKey() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const key = params.get('key') || '';
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    return key.trim();
  }

  async function ensureAnonymousSession() {
    const { data: sessionData, error: sessionError } = await db.auth.getSession();
    if (sessionError) throw sessionError;
    if (sessionData.session) return sessionData.session;
    const { data, error } = await db.auth.signInAnonymously();
    if (error) throw error;
    return data.session;
  }

  async function joinWithKey(key) {
    accessError.textContent = '';
    accessMessage.textContent = '비밀 링크를 확인하고 있어요.';
    const { data, error } = await db.rpc('join_trip', { p_access_key: key });
    if (error) throw error;
    tripId = data;
    localStorage.setItem(TRIP_ID_STORAGE, tripId);
    await loadData();
    subscribeRealtime();
    hideAccess();
    setSync('실시간 연결됨');
  }

  function mapShared(row) {
    return { id: row.id, name: row.item_name, amount: Number(row.amount), payer: row.payer, sort_order: row.sort_order };
  }

  function mapAdvance(row) {
    return { id: row.id, name: row.item_name, amount: Number(row.amount), payer: row.payer, owner: row.owner, sort_order: row.sort_order };
  }

  async function loadData() {
    if (!tripId) return;
    const [sharedResult, advanceResult] = await Promise.all([
      db.from('shared_expenses')
        .select('id,category,item_name,amount,payer,sort_order,updated_at')
        .eq('trip_id', tripId)
        .order('category')
        .order('sort_order')
        .order('created_at'),
      db.from('advance_expenses')
        .select('id,item_name,amount,payer,owner,sort_order,updated_at')
        .eq('trip_id', tripId)
        .order('sort_order')
        .order('created_at')
    ]);
    if (sharedResult.error) throw sharedResult.error;
    if (advanceResult.error) throw advanceResult.error;

    CATS.forEach(cat => { items[cat.key] = []; });
    sharedResult.data.forEach(row => {
      if (items[row.category]) items[row.category].push(mapShared(row));
    });
    items.advance = advanceResult.data.map(mapAdvance);
    renderAll();
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        await loadData();
        setSync('실시간 연결됨');
      } catch (error) {
        setSync('동기화 오류', 'error');
        console.error(error);
      }
    }, 220);
  }

  function subscribeRealtime() {
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    realtimeChannel = db.channel(`trip-${tripId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'shared_expenses', filter: `trip_id=eq.${tripId}`
      }, scheduleReload)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'advance_expenses', filter: `trip_id=eq.${tripId}`
      }, scheduleReload)
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setSync('실시간 연결됨');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('재연결 중', 'error');
      });
  }

  function queueUpdate(table, id, payload) {
    const previous = updateJobs.get(id) || { payload: {}, timer: null };
    clearTimeout(previous.timer);
    const job = { payload: { ...previous.payload, ...payload }, timer: null };
    setSync('저장 중', 'saving');
    job.timer = setTimeout(async () => {
      updateJobs.delete(id);
      const { error } = await db.from(table).update(job.payload).eq('id', id).eq('trip_id', tripId);
      if (error) {
        setSync('저장 실패', 'error');
        console.error(error);
        scheduleReload();
      } else {
        setSync('저장됨');
      }
    }, 450);
    updateJobs.set(id, job);
  }

  updateItem = function (cat, id, field, value) {
    const item = items[cat].find(entry => String(entry.id) === String(id));
    if (!item) return;
    if (field === 'amount') {
      item.amount = Math.max(0, Number(value) || 0);
      queueUpdate('shared_expenses', id, { amount: item.amount });
    } else if (field === 'payer' && (value === '카피바라' || value === '수달')) {
      item.payer = value;
      queueUpdate('shared_expenses', id, { payer: value });
    } else if (field === 'name') {
      item.name = value;
      if (value.trim()) queueUpdate('shared_expenses', id, { item_name: value.trim() });
      else setSync('항목명을 입력해 주세요', 'error');
    }
    updateCatTotal(cat);
    renderResult();
  };

  addBlankItem = async function (cat) {
    setSync('저장 중', 'saving');
    const sortOrder = Math.max(0, ...items[cat].map(item => Number(item.sort_order) || 0)) + 10;
    const { data, error } = await db.from('shared_expenses').insert({
      trip_id: tripId,
      category: cat,
      item_name: '새 항목',
      amount: 0,
      payer: '카피바라',
      sort_order: sortOrder
    }).select('id,category,item_name,amount,payer,sort_order').single();
    if (error) {
      setSync('추가 실패', 'error');
      console.error(error);
      return;
    }
    const item = mapShared(data);
    items[cat].push(item);
    renderAll();
    const input = document.querySelector(`[data-item-id="${item.id}"]`);
    if (input) { input.focus(); input.select(); }
    setSync('저장됨');
  };

  delItem = async function (cat, id) {
    setSync('삭제 중', 'saving');
    const { error } = await db.from('shared_expenses').delete().eq('id', id).eq('trip_id', tripId);
    if (error) {
      setSync('삭제 실패', 'error');
      console.error(error);
      return;
    }
    items[cat] = items[cat].filter(item => String(item.id) !== String(id));
    renderAll();
    setSync('삭제됨');
  };

  updateAdvance = function (id, field, value) {
    const item = items.advance.find(entry => String(entry.id) === String(id));
    if (!item) return;
    const payload = {};
    let rerender = false;
    if (field === 'amount') {
      item.amount = Math.max(0, Number(value) || 0);
      payload.amount = item.amount;
    } else if (field === 'name') {
      item.name = value;
      if (value.trim()) payload.item_name = value.trim();
      else setSync('항목명을 입력해 주세요', 'error');
    } else if (field === 'payer' && (value === '카피바라' || value === '수달')) {
      item.payer = value;
      if (item.owner === value) item.owner = otherPerson(value);
      payload.payer = item.payer;
      payload.owner = item.owner;
      rerender = true;
    } else if (field === 'owner' && (value === '카피바라' || value === '수달')) {
      item.owner = value;
      if (item.payer === value) item.payer = otherPerson(value);
      payload.payer = item.payer;
      payload.owner = item.owner;
      rerender = true;
    }
    if (Object.keys(payload).length) queueUpdate('advance_expenses', id, payload);
    if (rerender) renderAdvance(); else updateAdvanceTotal();
    renderResult();
  };

  addBlankAdvance = async function () {
    setSync('저장 중', 'saving');
    const sortOrder = Math.max(0, ...items.advance.map(item => Number(item.sort_order) || 0)) + 10;
    const { data, error } = await db.from('advance_expenses').insert({
      trip_id: tripId,
      item_name: '새 대신 결제',
      amount: 0,
      payer: '수달',
      owner: '카피바라',
      sort_order: sortOrder
    }).select('id,item_name,amount,payer,owner,sort_order').single();
    if (error) {
      setSync('추가 실패', 'error');
      console.error(error);
      return;
    }
    const item = mapAdvance(data);
    items.advance.push(item);
    renderAll();
    const input = document.querySelector(`[data-advance-id="${item.id}"]`);
    if (input) { input.focus(); input.select(); }
    setSync('저장됨');
  };

  delAdvance = async function (id) {
    setSync('삭제 중', 'saving');
    const { error } = await db.from('advance_expenses').delete().eq('id', id).eq('trip_id', tripId);
    if (error) {
      setSync('삭제 실패', 'error');
      console.error(error);
      return;
    }
    items.advance = items.advance.filter(item => String(item.id) !== String(id));
    renderAll();
    setSync('삭제됨');
  };

  accessForm.addEventListener('submit', async event => {
    event.preventDefault();
    const key = accessInput.value.trim();
    if (!key) {
      accessError.textContent = '비밀 접근키를 입력해 주세요.';
      return;
    }
    accessInput.value = '';
    try {
      await joinWithKey(key);
    } catch (error) {
      showAccess('정산표를 열려면 비밀 접근키가 필요해요.', friendlyError(error));
    }
  });

  async function init() {
    try {
      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Supabase library failed to load');
      }
      if (!config.supabaseUrl || !config.supabasePublishableKey || config.supabaseUrl.startsWith('__') || config.supabasePublishableKey.startsWith('__')) {
        accessMessage.textContent = 'Supabase 공개 연결 정보를 설정하는 중이에요.';
        accessError.textContent = '배포 설정이 아직 완료되지 않았어요.';
        setSync('설정 필요', 'error');
        return;
      }

      db = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      await ensureAnonymousSession();

      const fragmentKey = consumeFragmentKey();
      if (fragmentKey) {
        await joinWithKey(fragmentKey);
        return;
      }

      const savedTripId = localStorage.getItem(TRIP_ID_STORAGE);
      if (savedTripId) {
        tripId = savedTripId;
        try {
          await loadData();
          subscribeRealtime();
          hideAccess();
          setSync('실시간 연결됨');
          return;
        } catch (error) {
          localStorage.removeItem(TRIP_ID_STORAGE);
          tripId = null;
        }
      }
      showAccess('정산표를 열려면 비밀 초대 링크 또는 접근키가 필요해요.');
      setSync('접근키 필요', 'error');
    } catch (error) {
      showAccess('공동 정산표에 연결하지 못했어요.', friendlyError(error));
      setSync('연결 실패', 'error');
    }
  }

  init();
})();
