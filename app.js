(() => {
  'use strict';

  const config = window.KIKUCHI_CONFIG || {};
  const connectionScreen = document.getElementById('connection-screen');
  const connectionMessage = document.getElementById('connection-message');
  const connectionError = document.getElementById('connection-error');
  const syncState = document.getElementById('sync-state');
  const syncText = document.getElementById('sync-text');
  const pageTitle = document.getElementById('page-title');
  const resetAllButton = document.getElementById('reset-all-btn');
  const RESET_STORAGE = 'kikuchi-last-reset-at';
  const DEFAULT_TITLE = '키쿠치 여름방학 정산';

  let db = null;
  let tripId = null;
  let realtimeChannel = null;
  let reloadTimer = null;
  let titleSaveTimer = null;
  let savedTitle = DEFAULT_TITLE;
  const updateJobs = new Map();

  function setSync(label, state = '') {
    syncText.textContent = label;
    syncState.className = `sync-state${state ? ` ${state}` : ''}`;
  }

  function friendlyError(error, fallback = '연결 중 문제가 생겼어요.') {
    console.error(error);
    if (error && /anonymous sign-ins/i.test(error.message || '')) return 'Supabase에서 익명 로그인을 먼저 허용해야 해요.';
    return fallback;
  }

  function showConnectionError(message, error = '') {
    connectionMessage.textContent = message;
    connectionError.textContent = error;
    connectionScreen.classList.remove('is-hidden');
  }

  function hideConnection() {
    connectionScreen.classList.add('is-hidden');
    connectionError.textContent = '';
  }

  async function ensureAnonymousSession() {
    const { data: sessionData, error: sessionError } = await db.auth.getSession();
    if (sessionError) throw sessionError;
    if (sessionData.session) return sessionData.session;
    const { data, error } = await db.auth.signInAnonymously();
    if (error) throw error;
    return data.session;
  }

  function clearHeaderPhotos() {
    localStorage.removeItem(HEADER_PHOTOS.left);
    localStorage.removeItem(HEADER_PHOTOS.right);
    ['left', 'right'].forEach(side => {
      const box = document.getElementById(`header-photo-${side}`);
      const image = document.getElementById(`header-image-${side}`);
      if (box) box.classList.remove('has-image');
      if (image) { image.removeAttribute('src'); image.style.display = ''; }
    });
  }

  function applyTripMeta(meta) {
    const title = (meta.title || DEFAULT_TITLE).trim().slice(0, 100) || DEFAULT_TITLE;
    savedTitle = title;
    if (document.activeElement !== pageTitle) pageTitle.textContent = title;
    if (meta.reset_at) {
      const lastReset = localStorage.getItem(RESET_STORAGE) || '';
      if (meta.reset_at !== lastReset) {
        clearHeaderPhotos();
        localStorage.setItem(RESET_STORAGE, meta.reset_at);
      }
    }
  }

  async function loadTripMeta() {
    const { data, error } = await db.from('trips')
      .select('title,reset_at')
      .eq('id', tripId)
      .single();
    if (error) throw error;
    applyTripMeta(data);
  }

  async function saveTitle() {
    const title = pageTitle.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!title) {
      pageTitle.textContent = savedTitle;
      setSync('제목을 입력해 주세요', 'error');
      return;
    }
    setSync('제목 저장 중', 'saving');
    const { error } = await db.from('trips').update({ title }).eq('id', tripId);
    if (error) {
      pageTitle.textContent = savedTitle;
      setSync('제목 저장 실패', 'error');
      console.error(error);
      return;
    }
    savedTitle = title;
    pageTitle.textContent = title;
    setSync('저장됨');
  }

  function setupTitleEditing() {
    pageTitle.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); pageTitle.blur(); }
    });
    pageTitle.addEventListener('input', () => {
      clearTimeout(titleSaveTimer);
      titleSaveTimer = setTimeout(saveTitle, 550);
    });
    pageTitle.addEventListener('blur', () => {
      clearTimeout(titleSaveTimer);
      saveTitle();
    });
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
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${tripId}`
      }, payload => applyTripMeta(payload.new))
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

  async function resetAllData() {
    const confirmation = window.prompt('정산 내역·제목·사진을 모두 초기화합니다. 계속하려면 "전체 삭제"를 입력해 주세요.');
    if (confirmation === null) return;
    if (confirmation.trim() !== '전체 삭제') {
      window.alert('확인 문구가 일치하지 않아 삭제하지 않았어요.');
      return;
    }
    resetAllButton.disabled = true;
    setSync('전체 삭제 중', 'saving');
    try {
      const { error } = await db.rpc('reset_trip_data');
      if (error) throw error;
      await Promise.all([loadTripMeta(), loadData()]);
      setSync('전체 삭제 완료');
    } catch (error) {
      setSync('전체 삭제 실패', 'error');
      console.error(error);
      window.alert('전체 삭제에 실패했어요. 데이터는 임의로 추가 삭제하지 않았어요.');
    } finally {
      resetAllButton.disabled = false;
    }
  }

  async function init() {
    try {
      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Supabase library failed to load');
      }
      if (!config.supabaseUrl || !config.supabasePublishableKey || !/^[0-9a-f-]{36}$/.test(config.tripId || '') || config.supabaseUrl.startsWith('__') || config.supabasePublishableKey.startsWith('__')) {
        connectionMessage.textContent = 'Supabase 공개 연결 정보를 설정하는 중이에요.';
        connectionError.textContent = '배포 설정이 아직 완료되지 않았어요.';
        setSync('설정 필요', 'error');
        return;
      }

      db = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      await ensureAnonymousSession();
      tripId = config.tripId;
      setupTitleEditing();
      resetAllButton.addEventListener('click', resetAllData);
      await Promise.all([loadTripMeta(), loadData()]);
      subscribeRealtime();
      hideConnection();
      setSync('실시간 연결됨');
    } catch (error) {
      showConnectionError('공동 정산표에 연결하지 못했어요.', friendlyError(error));
      setSync('연결 실패', 'error');
    }
  }

  init();
})();
