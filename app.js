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
  const attachmentModal = document.getElementById('attachment-modal');
  const attachmentModalTitle = document.getElementById('attachment-modal-title');
  const attachmentInput = document.getElementById('attachment-input');
  const attachmentList = document.getElementById('attachment-list');
  const attachmentUploadLabel = document.getElementById('attachment-upload-label');
  const attachmentClose = document.getElementById('attachment-close');
  const RESET_STORAGE = 'kikuchi-last-reset-at';
  const DEFAULT_TITLE = '키쿠치 여름방학 정산';
  const ATTACHMENT_BUCKET = 'expense-attachments';
  const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_ITEM = 5;
  const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']);

  let db = null;
  let tripId = null;
  let realtimeChannel = null;
  let reloadTimer = null;
  let titleSaveTimer = null;
  let savedTitle = DEFAULT_TITLE;
  let attachmentRows = [];
  let activeAttachmentTarget = null;
  let attachmentReloadTimer = null;
  let attachmentRenderToken = 0;
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
    if (!sessionError && sessionData.session) {
      const { data: userData, error: userError } = await db.auth.getUser();
      if (!userError && userData.user) return sessionData.session;
    }

    if (sessionError || sessionData.session) {
      const { error: signOutError } = await db.auth.signOut({ scope: 'local' });
      if (signOutError) console.warn('Failed to clear stale anonymous session', signOutError);
    }

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

  function attachmentKey(type, expenseId) {
    return `${type}:${expenseId}`;
  }

  function rebuildAttachmentCounts() {
    attachmentCounts = {};
    attachmentRows.forEach(row => {
      const key = attachmentKey(row.expense_type, row.expense_id);
      attachmentCounts[key] = (attachmentCounts[key] || 0) + 1;
    });
  }

  function rowsForAttachmentTarget(type, expenseId) {
    return attachmentRows.filter(row => row.expense_type === type && String(row.expense_id) === String(expenseId));
  }

  async function loadAttachmentMetadata() {
    const { data, error } = await db.from('expense_attachments')
      .select('id,expense_type,expense_id,object_path,original_name,mime_type,size_bytes,created_at')
      .eq('trip_id', tripId)
      .order('created_at');
    if (error) throw error;
    attachmentRows = data || [];
    rebuildAttachmentCounts();
    renderAll();
    if (attachmentModal.open && activeAttachmentTarget) await renderAttachmentModal();
  }

  function scheduleAttachmentReload() {
    clearTimeout(attachmentReloadTimer);
    attachmentReloadTimer = setTimeout(async () => {
      try {
        await loadAttachmentMetadata();
        setSync('실시간 연결됨');
      } catch (error) {
        setSync('첨부 동기화 오류', 'error');
        console.error(error);
      }
    }, 220);
  }

  function findExpenseName(type, expenseId) {
    if (type === 'advance') return items.advance.find(item => String(item.id) === String(expenseId))?.name || '대신 결제 항목';
    return CATS.flatMap(cat => items[cat.key]).find(item => String(item.id) === String(expenseId))?.name || '공동경비 항목';
  }

  function formatAttachmentSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  async function renderAttachmentModal() {
    if (!activeAttachmentTarget) return;
    const token = ++attachmentRenderToken;
    const rows = rowsForAttachmentTarget(activeAttachmentTarget.type, activeAttachmentTarget.id);
    attachmentModalTitle.textContent = `${findExpenseName(activeAttachmentTarget.type, activeAttachmentTarget.id)} · 첨부파일`;
    attachmentUploadLabel.classList.toggle('is-disabled', rows.length >= MAX_ATTACHMENTS_PER_ITEM);
    attachmentUploadLabel.innerHTML = rows.length >= MAX_ATTACHMENTS_PER_ITEM
      ? '<i class="ti ti-lock"></i> 첨부 한도 5개'
      : '<i class="ti ti-paperclip"></i> 첨부파일 추가';
    if (!rows.length) {
      attachmentList.innerHTML = '<div class="attachment-empty">첨부된 파일이 아직 없어요</div>';
      return;
    }
    attachmentList.innerHTML = '<div class="attachment-empty">첨부파일을 불러오는 중이에요</div>';
    const cards = await Promise.all(rows.map(async row => {
      const { data, error } = await db.storage.from(ATTACHMENT_BUCKET).createSignedUrl(row.object_path, 60);
      const signedUrl = error ? '' : data.signedUrl;
      const isImage = row.mime_type.startsWith('image/');
      const preview = signedUrl && isImage
        ? `<img src="${escapeAttr(signedUrl)}" alt="${escapeAttr(row.original_name)} 미리보기"/>`
        : `<i class="ti ${row.mime_type === 'application/pdf' ? 'ti-file-type-pdf' : 'ti-file'}"></i>`;
      const date = new Date(row.created_at).toLocaleDateString('ko-KR');
      return `<div class="attachment-card" data-attachment-id="${row.id}">
        <a class="attachment-preview" href="${escapeAttr(signedUrl || '#')}" target="_blank" rel="noopener" aria-label="${escapeAttr(row.original_name)} 열기">${preview}</a>
        <div class="attachment-info"><a class="attachment-name" href="${escapeAttr(signedUrl || '#')}" target="_blank" rel="noopener">${escapeAttr(row.original_name)}</a><div class="attachment-meta">${formatAttachmentSize(Number(row.size_bytes))} · ${date}</div></div>
        <button class="attachment-delete" type="button" aria-label="${escapeAttr(row.original_name)} 삭제" onclick="deleteAttachment('${row.id}')"><i class="ti ti-trash"></i></button>
      </div>`;
    }));
    if (token === attachmentRenderToken) attachmentList.innerHTML = cards.join('');
  }

  window.openAttachmentModal = async function (type, expenseId) {
    activeAttachmentTarget = { type, id: expenseId };
    if (!attachmentModal.open) attachmentModal.showModal();
    await renderAttachmentModal();
  };

  function extensionForAttachment(file) {
    const byType = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/heic':'heic', 'image/heif':'heif', 'application/pdf':'pdf' };
    return byType[file.type] || 'bin';
  }

  async function prepareAttachmentFile(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size < 700 * 1024) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .84));
      if (blob && blob.size < file.size) return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp' });
    } catch (error) {
      console.warn('이미지 압축을 건너뜁니다.', error);
    }
    return file;
  }

  async function uploadAttachment(fileList) {
    if (!activeAttachmentTarget) return;
    const existing = rowsForAttachmentTarget(activeAttachmentTarget.type, activeAttachmentTarget.id).length;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (existing + files.length > MAX_ATTACHMENTS_PER_ITEM) {
      window.alert(`한 항목에는 최대 ${MAX_ATTACHMENTS_PER_ITEM}개까지 첨부할 수 있어요.`);
      return;
    }
    for (const originalFile of files) {
      if (!ALLOWED_ATTACHMENT_TYPES.has(originalFile.type)) {
        window.alert(`${originalFile.name}: 이미지 또는 PDF만 첨부할 수 있어요.`);
        continue;
      }
      if (!originalFile.size || originalFile.size > MAX_ATTACHMENT_SIZE) {
        window.alert(`${originalFile.name}: 파일 크기는 10MB 이하여야 해요.`);
        continue;
      }
      setSync('첨부파일 업로드 중', 'saving');
      const file = await prepareAttachmentFile(originalFile);
      const objectPath = `${tripId}/${activeAttachmentTarget.type}/${activeAttachmentTarget.id}/${crypto.randomUUID()}.${extensionForAttachment(file)}`;
      const { error: uploadError } = await db.storage.from(ATTACHMENT_BUCKET).upload(objectPath, file, { contentType: file.type, upsert: false, cacheControl: '0' });
      if (uploadError) {
        setSync('첨부 업로드 실패', 'error');
        console.error(uploadError);
        continue;
      }
      const originalName = originalFile.name.trim().slice(0, 180) || `첨부파일.${extensionForAttachment(file)}`;
      const { error: metadataError } = await db.from('expense_attachments').insert({
        trip_id: tripId,
        expense_type: activeAttachmentTarget.type,
        expense_id: activeAttachmentTarget.id,
        object_path: objectPath,
        original_name: originalName,
        mime_type: file.type,
        size_bytes: file.size
      });
      if (metadataError) {
        await db.storage.from(ATTACHMENT_BUCKET).remove([objectPath]);
        setSync('첨부 저장 실패', 'error');
        console.error(metadataError);
        continue;
      }
    }
    await loadAttachmentMetadata();
    setSync('첨부 저장됨');
  }

  window.deleteAttachment = async function (attachmentId) {
    const row = attachmentRows.find(item => String(item.id) === String(attachmentId));
    if (!row || !window.confirm(`"${row.original_name}" 파일을 삭제할까?`)) return;
    setSync('첨부파일 삭제 중', 'saving');
    const { error: metadataError } = await db.from('expense_attachments').delete().eq('id', row.id).eq('trip_id', tripId);
    if (metadataError) {
      setSync('첨부 삭제 실패', 'error');
      console.error(metadataError);
      return;
    }
    const { error: storageError } = await db.storage.from(ATTACHMENT_BUCKET).remove([row.object_path]);
    if (storageError) console.error(storageError);
    await loadAttachmentMetadata();
    setSync(storageError ? '목록 삭제됨 · 파일 정리 지연' : '첨부 삭제됨', storageError ? 'error' : '');
  };

  async function cleanupExpenseAttachments(type, expenseId, paths = null) {
    const objectPaths = paths || rowsForAttachmentTarget(type, expenseId).map(row => row.object_path);
    if (!objectPaths.length) return;
    const { error: metadataError } = await db.from('expense_attachments').delete()
      .eq('trip_id', tripId).eq('expense_type', type).eq('expense_id', expenseId);
    if (metadataError) throw metadataError;
    const { error: storageError } = await db.storage.from(ATTACHMENT_BUCKET).remove(objectPaths);
    if (storageError) console.error(storageError);
    attachmentRows = attachmentRows.filter(row => !(row.expense_type === type && String(row.expense_id) === String(expenseId)));
    rebuildAttachmentCounts();
  }

  async function cleanupAllAttachmentObjects(paths) {
    if (!paths.length) return;
    for (let offset = 0; offset < paths.length; offset += 100) {
      const { error } = await db.storage.from(ATTACHMENT_BUCKET).remove(paths.slice(offset, offset + 100));
      if (error) console.error(error);
    }
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
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'expense_attachments', filter: `trip_id=eq.${tripId}`
      }, scheduleAttachmentReload)
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
    const attachmentPaths = rowsForAttachmentTarget('shared', id).map(row => row.object_path);
    if (attachmentPaths.length && !window.confirm(`이 항목과 첨부파일 ${attachmentPaths.length}개를 함께 삭제할까?`)) return;
    setSync('삭제 중', 'saving');
    const { error } = await db.from('shared_expenses').delete().eq('id', id).eq('trip_id', tripId);
    if (error) {
      setSync('삭제 실패', 'error');
      console.error(error);
      return;
    }
    try { await cleanupExpenseAttachments('shared', id, attachmentPaths); }
    catch (cleanupError) { console.error(cleanupError); }
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
    const attachmentPaths = rowsForAttachmentTarget('advance', id).map(row => row.object_path);
    if (attachmentPaths.length && !window.confirm(`이 항목과 첨부파일 ${attachmentPaths.length}개를 함께 삭제할까?`)) return;
    setSync('삭제 중', 'saving');
    const { error } = await db.from('advance_expenses').delete().eq('id', id).eq('trip_id', tripId);
    if (error) {
      setSync('삭제 실패', 'error');
      console.error(error);
      return;
    }
    try { await cleanupExpenseAttachments('advance', id, attachmentPaths); }
    catch (cleanupError) { console.error(cleanupError); }
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
      const attachmentPaths = attachmentRows.map(row => row.object_path);
      const { error } = await db.rpc('reset_trip_data');
      if (error) throw error;
      await cleanupAllAttachmentObjects(attachmentPaths);
      await Promise.all([loadTripMeta(), loadData(), loadAttachmentMetadata()]);
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
      attachmentClose.addEventListener('click', () => attachmentModal.close());
      attachmentModal.addEventListener('click', event => { if (event.target === attachmentModal) attachmentModal.close(); });
      attachmentModal.addEventListener('close', () => { activeAttachmentTarget = null; attachmentInput.value = ''; });
      attachmentInput.addEventListener('change', async () => {
        try { await uploadAttachment(attachmentInput.files); }
        finally { attachmentInput.value = ''; }
      });
      await Promise.all([loadTripMeta(), loadData(), loadAttachmentMetadata()]);
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
