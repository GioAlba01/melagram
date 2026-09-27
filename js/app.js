// ============================================================================
// Melagram — configurazione
// ============================================================================
const SUPABASE_URL = "https://pveifyerzesfnysmoaqd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2ZWlmeWVyemVzZm55c21vYXFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MDEyNjMsImV4cCI6MjEwNjA3NzI2M30.NUbOXAM3CT7hfKFKAiN05JXNJLn1Yx8enIjgbw1a6sc";
const BUCKET = "wedding-photos";

// URL del "Web App" di Google Apps Script che salva una copia di ogni foto
// nel Google Drive di tuo fratello. Vuoto = backup su Drive disattivato.
// Va compilato con l'URL che termina in /exec una volta pubblicato lo script.
const DRIVE_BACKUP_URL = "https://script.google.com/macros/s/AKfycbzTKSKpFXEuB-gOBfpcz4gthVo3IKaeqjZoSQfAEIOp3BZ7M7AIqdyUpoNNWUV2o_f6Gg/exec";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// Stato locale
// ============================================================================
const state = {
  guestId: null,
  guestName: null,
  isAdmin: false,
  activeView: 'home', // 'home' | 'news' | 'profile'
  homeSort: 'recent', // 'recent' | 'likes' — ordinamento della Home
  posts: new Map(),   // id -> { data, likeCount, commentCount, likedByMe, commentsLoaded, cardEl }
  order: [],          // id in ordine di creazione decrescente
};

const els = {};
document.querySelectorAll('[id]').forEach(el => { els[el.id] = el; });

const tplPost = document.getElementById('tplPost');
const tplComment = document.getElementById('tplComment');

// ============================================================================
// Utility
// ============================================================================
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ora';
  if (diff < 3600) return Math.floor(diff / 60) + ' min fa';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h fa';
  return Math.floor(diff / 86400) + ' g fa';
}

function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setAdminUI(isAdmin) {
  state.isAdmin = isAdmin;
  document.body.classList.toggle('is-admin', isAdmin);
  document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !isAdmin; });
}

function pathFromPublicUrl(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  return idx >= 0 ? decodeURIComponent(url.slice(idx + marker.length)) : null;
}

// ============================================================================
// Identità ospite
// ============================================================================
function loadIdentity() {
  // Passaggio al sistema nome+password: azzera l'identità testuale salvata
  // in locale dalle versioni precedenti (senza password), una volta sola,
  // così tutti ripassano dal nuovo login/registrazione.
  const IDENTITY_VERSION = '3';
  if (localStorage.getItem('melagram_identity_version') !== IDENTITY_VERSION) {
    localStorage.removeItem('melagram_guest_name');
    localStorage.setItem('melagram_identity_version', IDENTITY_VERSION);
  }

  state.guestId = localStorage.getItem('melagram_guest_id');
  if (!state.guestId) {
    state.guestId = uuid();
    localStorage.setItem('melagram_guest_id', state.guestId);
  }
  state.guestName = localStorage.getItem('melagram_guest_name');
  updateGuestLabels();
  if (!state.guestName) openNameModal();
}

function updateGuestLabels() {
  const label = state.guestName || '…';
  if (els.guestNameLabel) els.guestNameLabel.textContent = label;
  if (els.guestNameLabel2) els.guestNameLabel2.textContent = label;
  refreshAdminZoneVisibility();
}

// La sezione "Area amministratore" nel Profilo si vede solo a chi si è
// dato il nome segreto "Charge" (nessuna vera protezione: è solo per
// non mostrarla per sbaglio agli altri invitati; il vero accesso resta
// protetto dall'accesso Supabase con email e password).
function refreshAdminZoneVisibility() {
  if (!els.adminZone) return;
  const isTrigger = (state.guestName || '').trim().toLowerCase() === 'charge';
  els.adminZone.hidden = !isTrigger;
}

// Stato del piccolo "wizard" a due tap del modale nome:
// 1° tap → controlla se il nome esiste già (mostra il campo password)
// 2° tap → accede (nome esistente) o crea il profilo (nome libero)
let nameFlowState = null; // null | 'exists' | 'free'
let nameFlowFor = null;   // nome (minuscolo) a cui si riferisce nameFlowState

function resetNameFlow() {
  nameFlowState = null;
  nameFlowFor = null;
  els.namePasswordWrap.hidden = true;
  els.inputNamePassword.value = '';
  els.saveNameLabel.textContent = 'Continua';
}

function setNameBusy(busy) {
  els.btnSaveName.disabled = busy;
  els.saveNameSpinner.hidden = !busy;
}

function openNameModal() {
  els.inputName.value = state.guestName || '';
  els.nameError.hidden = true;
  resetNameFlow();
  els.modalName.hidden = false;
  setTimeout(() => els.inputName.focus(), 50);
}

function applyLogin(guestId, name) {
  // Ricarica subito la pagina invece di aggiornare lo stato "a caldo":
  // cambiando identità cambiano anche i like già messi, le foto del
  // profilo, ecc. Un reload pulito evita che restino in giro dati
  // dell'utente precedente finché non si tocca qualcos'altro.
  localStorage.setItem('melagram_guest_id', guestId);
  localStorage.setItem('melagram_guest_name', name);
  window.location.reload();
}

els.inputName.addEventListener('input', () => {
  // Se l'utente modifica il nome dopo un controllo già fatto, si riparte da capo.
  if (nameFlowState && els.inputName.value.trim().toLowerCase() !== nameFlowFor) {
    resetNameFlow();
    els.nameError.hidden = true;
  }
});

els.btnSaveName.addEventListener('click', async () => {
  const name = els.inputName.value.trim().slice(0, 40);
  if (!name) {
    els.nameError.textContent = 'Inserisci il tuo nome.';
    els.nameError.hidden = false;
    return;
  }
  els.nameError.hidden = true;
  const key = name.toLowerCase();

  // 1° tap: il nome non è ancora stato verificato → controlla se esiste già.
  if (nameFlowState === null || nameFlowFor !== key) {
    setNameBusy(true);
    const { data: exists, error } = await sb.rpc('guest_name_exists', { p_name: name });
    setNameBusy(false);

    if (error) {
      els.nameError.textContent = 'Errore di connessione, riprova.';
      els.nameError.hidden = false;
      return;
    }

    nameFlowFor = key;
    nameFlowState = exists ? 'exists' : 'free';
    els.namePasswordWrap.hidden = false;
    els.namePasswordHint.textContent = exists
      ? 'Questo nome esiste già: inserisci la password per accedere al tuo profilo.'
      : 'Nome libero: scegli una password per proteggerlo (almeno 3 caratteri).';
    els.saveNameLabel.textContent = exists ? 'Accedi' : 'Crea profilo';
    setTimeout(() => els.inputNamePassword.focus(), 50);
    return;
  }

  // 2° tap: accesso o creazione del profilo con la password inserita.
  const password = els.inputNamePassword.value;
  if (!password) {
    els.nameError.textContent = 'Inserisci la password.';
    els.nameError.hidden = false;
    return;
  }

  if (nameFlowState === 'exists') {
    setNameBusy(true);
    const { data: guestId, error } = await sb.rpc('login_guest', { p_name: name, p_password: password });
    setNameBusy(false);
    if (error || !guestId) {
      // Mostra il messaggio giusto per una password sbagliata, altrimenti
      // il vero errore tecnico (utile per diagnosticare problemi imprevisti).
      els.nameError.textContent = (error?.message === 'PASSWORD_ERRATA' || error?.message === 'NOME_NON_TROVATO')
        ? 'Password errata. Riprova, oppure scegli un nome diverso.'
        : 'Errore tecnico: ' + (error?.message || 'riprova.');
      els.nameError.hidden = false;
      return;
    }
    applyLogin(guestId, name);
  } else {
    if (password.length < 3) {
      els.nameError.textContent = 'La password deve avere almeno 3 caratteri.';
      els.nameError.hidden = false;
      return;
    }
    setNameBusy(true);
    const { data: guestId, error } = await sb.rpc('register_guest', { p_name: name, p_password: password });
    setNameBusy(false);
    if (error || !guestId) {
      els.nameError.textContent = (error?.message === 'NOME_GIA_USATO')
        ? 'Questo nome è appena stato preso da qualcun altro. Provane un altro.'
        : 'Errore tecnico: ' + (error?.message || 'riprova.');
      els.nameError.hidden = false;
      resetNameFlow();
      return;
    }
    applyLogin(guestId, name);
  }
});

els.inputName.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.btnSaveName.click();
});
els.inputNamePassword.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.btnSaveName.click();
});

document.querySelectorAll('.js-change-name').forEach(btn => {
  btn.addEventListener('click', openNameModal);
});

function requireName() {
  if (!state.guestName) { openNameModal(); return false; }
  return true;
}

// ============================================================================
// Navigazione tra viste (Home / Profilo)
// ============================================================================
function switchView(view) {
  state.activeView = view;
  localStorage.setItem('melagram_active_view', view);

  document.querySelectorAll('.js-nav').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  els.viewHome.hidden = view !== 'home';
  els.viewNews.hidden = view !== 'news';
  els.viewProfile.hidden = view !== 'profile';

  reflowActiveView();
}

document.querySelectorAll('.js-nav').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Filtro di ordinamento della Home: più recenti (default) o più like
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.homeSort = btn.dataset.sort;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    reflowActiveView();
  });
});

function getHomeOrder() {
  if (state.homeSort !== 'likes') return state.order;
  // Copia l'ordine e riordina per numero di like (a parità, il più recente prima).
  return [...state.order].sort((a, b) => {
    const diff = (state.posts.get(b)?.likeCount || 0) - (state.posts.get(a)?.likeCount || 0);
    if (diff !== 0) return diff;
    return new Date(state.posts.get(b)?.data.created_at) - new Date(state.posts.get(a)?.data.created_at);
  });
}

function reflowActiveView() {
  if (state.activeView === 'news') return; // il feed News si gestisce da sé (vedi reflowNews)
  const container = state.activeView === 'home' ? els.feedHome : els.feedProfile;
  const emptyEl = state.activeView === 'home' ? els.emptyHome : els.emptyProfile;

  const ids = state.activeView === 'home'
    ? getHomeOrder()
    : state.order.filter(id => state.posts.get(id)?.data.guest_id === state.guestId);

  container.innerHTML = '';
  for (const id of ids) {
    const entry = state.posts.get(id);
    if (entry?.cardEl) container.appendChild(entry.cardEl);
  }
  emptyEl.hidden = ids.length > 0;
}

// ============================================================================
// Feed — caricamento iniziale
// ============================================================================
async function loadFeed() {
  const { data: posts, error } = await sb
    .from('posts')
    .select('id, guest_id, author_name, image_url, caption, created_at, likes(count), comments(count)')
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) {
    toast('Impossibile caricare le foto: ' + error.message);
    return;
  }

  const { data: myLikes } = await sb
    .from('likes')
    .select('post_id')
    .eq('guest_id', state.guestId);
  const likedSet = new Set((myLikes || []).map(l => l.post_id));

  for (const p of posts) {
    addPostToState(p, {
      likeCount: p.likes?.[0]?.count || 0,
      commentCount: p.comments?.[0]?.count || 0,
      likedByMe: likedSet.has(p.id),
    });
  }
  reflowActiveView();
}

function addPostToState(post, counts) {
  if (state.posts.has(post.id)) return;
  const entry = {
    data: post,
    likeCount: counts.likeCount || 0,
    commentCount: counts.commentCount || 0,
    likedByMe: !!counts.likedByMe,
    commentsLoaded: false,
    cardEl: null,
  };
  state.posts.set(post.id, entry);
  entry.cardEl = renderCard(post.id, entry);
  state.order.unshift(post.id);
  state.order = [...new Set(state.order)]; // sicurezza
  // riordina per data se necessario
  state.order.sort((a, b) => new Date(state.posts.get(b).data.created_at) - new Date(state.posts.get(a).data.created_at));
}

function removePostFromState(postId) {
  const entry = state.posts.get(postId);
  if (!entry) return;
  entry.cardEl?.remove();
  state.posts.delete(postId);
  state.order = state.order.filter(id => id !== postId);
  reflowActiveView();
}

// ============================================================================
// Render di una card
// ============================================================================
function renderCard(postId, entry) {
  const node = tplPost.content.firstElementChild.cloneNode(true);
  const p = entry.data;

  const img = node.querySelector('.card-photo');
  img.src = p.image_url;
  img.alt = p.caption || `Foto di ${p.author_name}`;

  node.querySelector('.card-author').textContent = p.author_name;
  node.querySelector('.card-time').textContent = timeAgo(p.created_at);
  node.querySelector('.card-caption').textContent = p.caption || '';

  const delBtn = node.querySelector('.card-delete');
  delBtn.hidden = !(state.isAdmin || p.guest_id === state.guestId);
  delBtn.addEventListener('click', () => deletePost(postId));

  const likeBtn = node.querySelector('.like-btn');
  const likeCountEl = node.querySelector('.like-count');
  likeCountEl.textContent = entry.likeCount;
  likeBtn.classList.toggle('liked', entry.likedByMe);
  likeBtn.addEventListener('click', () => toggleLike(postId));

  const commentToggle = node.querySelector('.comment-toggle');
  const commentCountEl = node.querySelector('.comment-count');
  commentCountEl.textContent = entry.commentCount;
  const commentsPanel = node.querySelector('.card-comments');
  commentToggle.addEventListener('click', () => toggleComments(postId, commentsPanel));

  const commentInput = node.querySelector('.comment-input');
  const commentSend = node.querySelector('.comment-send');
  const sendComment = () => submitComment(postId, commentInput);
  commentSend.addEventListener('click', sendComment);
  commentInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendComment(); });

  return node;
}

function updateCardLike(postId) {
  const entry = state.posts.get(postId);
  if (!entry?.cardEl) return;
  entry.cardEl.querySelector('.like-count').textContent = entry.likeCount;
  entry.cardEl.querySelector('.like-btn').classList.toggle('liked', entry.likedByMe);
  // Se in Home è attivo l'ordinamento per like, la classifica si aggiorna subito.
  if (state.activeView === 'home' && state.homeSort === 'likes') reflowActiveView();
}

function updateCardCommentCount(postId) {
  const entry = state.posts.get(postId);
  if (!entry?.cardEl) return;
  entry.cardEl.querySelector('.comment-count').textContent = entry.commentCount;
}

// ============================================================================
// Like
// ============================================================================
async function toggleLike(postId) {
  if (!requireName()) return;
  const entry = state.posts.get(postId);
  if (!entry) return;

  if (entry.likedByMe) {
    entry.likedByMe = false;
    entry.likeCount = Math.max(0, entry.likeCount - 1);
    updateCardLike(postId);
    const { error } = await sb.from('likes').delete()
      .eq('post_id', postId).eq('guest_id', state.guestId);
    if (error) { entry.likedByMe = true; entry.likeCount++; updateCardLike(postId); }
  } else {
    entry.likedByMe = true;
    entry.likeCount++;
    updateCardLike(postId);
    const { error } = await sb.from('likes').insert({ post_id: postId, guest_id: state.guestId });
    if (error) { entry.likedByMe = false; entry.likeCount = Math.max(0, entry.likeCount - 1); updateCardLike(postId); }
  }
}

// ============================================================================
// Commenti
// ============================================================================
async function toggleComments(postId, panelEl) {
  const willOpen = panelEl.hidden;
  panelEl.hidden = !willOpen;
  if (!willOpen) return;

  const entry = state.posts.get(postId);
  if (entry.commentsLoaded) return;

  const { data, error } = await sb
    .from('comments')
    .select('id, post_id, author_name, text, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });

  if (error) { toast('Impossibile caricare i commenti.'); return; }

  const list = panelEl.querySelector('.comment-list');
  list.innerHTML = '';
  for (const c of data) list.appendChild(renderComment(c));
  entry.commentsLoaded = true;
}

function renderComment(c) {
  const node = tplComment.content.firstElementChild.cloneNode(true);
  node.dataset.commentId = c.id;
  node.dataset.postId = c.post_id;

  const textEl = node.querySelector('.comment-text');
  textEl.textContent = c.text;
  node.querySelector('.comment-author').textContent = c.author_name + ':';

  const editBox = node.querySelector('.comment-edit-box');
  const editInput = node.querySelector('.comment-edit-input');

  const adminActions = node.querySelector('.comment-admin-actions');
  adminActions.hidden = !state.isAdmin;

  const editBtn = node.querySelector('.comment-edit-btn');
  editBtn.hidden = !state.isAdmin;
  editBtn.addEventListener('click', () => {
    editInput.value = textEl.textContent;
    textEl.hidden = true;
    editBox.hidden = false;
    editInput.focus();
  });

  node.querySelector('.comment-edit-cancel').addEventListener('click', () => {
    editBox.hidden = true;
    textEl.hidden = false;
  });

  node.querySelector('.comment-edit-save').addEventListener('click', async () => {
    const newText = editInput.value.trim();
    if (!newText) return;
    const { error } = await sb.from('comments').update({ text: newText }).eq('id', c.id);
    if (error) { toast('Impossibile salvare la modifica.'); return; }
    textEl.textContent = newText;
    editBox.hidden = true;
    textEl.hidden = false;
  });

  const delBtn = node.querySelector('.comment-delete');
  delBtn.hidden = !state.isAdmin;
  delBtn.addEventListener('click', () => deleteComment(c.id));

  return node;
}

async function submitComment(postId, inputEl) {
  if (!requireName()) return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.disabled = true;
  const { error } = await sb.from('comments').insert({
    post_id: postId, author_name: state.guestName, text,
  });
  inputEl.disabled = false;
  if (error) toast('Impossibile inviare il commento.');
}

async function deleteComment(commentId) {
  const { data, error } = await sb.from('comments').delete().eq('id', commentId).select('id');
  if (error) { toast('Errore: ' + error.message); return; }
  if (!data || data.length === 0) {
    toast('Eliminazione bloccata: non risulti connesso come amministratore su questo dispositivo.');
  }
}

// ============================================================================
// Upload foto
// ============================================================================
let pendingFile = null;
let pendingCompression = null;

function resetUploadModal() {
  pendingFile = null;
  pendingCompression = null;
  els.inputFileCamera.value = '';
  els.uploadChoice.hidden = false;
  els.filePreviewWrap.hidden = true;
  els.btnSavePhone.hidden = true;
  els.inputCaption.value = '';
  els.uploadError.hidden = true;
}

els.fab.addEventListener('click', () => {
  if (!requireName()) return;
  resetUploadModal();
  els.modalUpload.hidden = false;
});

els.btnCancelUpload.addEventListener('click', () => { els.modalUpload.hidden = true; });

// Ridimensiona e comprime la foto prima di caricarla (max 1920px sul lato
// lungo, qualità 85%): pesa molto meno ma resta nitida su schermo.
async function compressImage(file, maxDim = 1920, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    bitmap = await createImageBitmap(file);
  }

  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    if (width >= height) {
      height = Math.round(height * (maxDim / width));
      width = maxDim;
    } else {
      width = Math.round(width * (maxDim / height));
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function handleFileChosen(file) {
  if (!file) return;
  // Anteprima immediata con il file originale, poi si aggiorna con la versione compressa.
  els.filePreview.src = URL.createObjectURL(file);
  els.uploadChoice.hidden = true;
  els.filePreviewWrap.hidden = false;
  els.btnSavePhone.hidden = false;
  pendingFile = file;

  pendingCompression = compressImage(file)
    .then(blob => {
      if (blob) {
        pendingFile = blob;
        els.filePreview.src = URL.createObjectURL(blob);
      }
    })
    .catch(() => { /* se la compressione fallisce, si carica il file originale */ });
}

els.inputFileCamera.addEventListener('change', () => handleFileChosen(els.inputFileCamera.files[0]));

els.btnClearFile.addEventListener('click', resetUploadModal);

// Salva una copia della foto sul telefono di chi la scatta (facoltativo):
// usa la condivisione nativa se disponibile, altrimenti un download diretto.
els.btnSavePhone.addEventListener('click', async () => {
  if (!pendingFile) return;
  const fileToSave = pendingFile instanceof File
    ? pendingFile
    : new File([pendingFile], 'melagram-foto.jpg', { type: 'image/jpeg' });

  if (navigator.canShare && navigator.canShare({ files: [fileToSave] })) {
    try {
      await navigator.share({ files: [fileToSave] });
      return;
    } catch (e) {
      // Annullato dall'utente o non supportato: si prova con il download qui sotto.
    }
  }

  const url = URL.createObjectURL(fileToSave);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'melagram-foto.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.btnSubmitUpload.addEventListener('click', async () => {
  if (!pendingFile) {
    els.uploadError.textContent = 'Scegli prima una foto.';
    els.uploadError.hidden = false;
    return;
  }
  els.uploadError.hidden = true;
  els.uploadBtnLabel.hidden = true;
  els.uploadSpinner.hidden = false;
  els.btnSubmitUpload.disabled = true;

  try {
    if (pendingCompression) await pendingCompression; // aspetta che la compressione sia finita

    const path = `${state.guestId}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.jpg`;

    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, pendingFile, {
      contentType: 'image/jpeg',
    });
    if (upErr) throw upErr;

    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    const imageUrl = pub.publicUrl;

    const { error: insErr } = await sb.from('posts').insert({
      guest_id: state.guestId,
      author_name: state.guestName,
      image_url: imageUrl,
      caption: els.inputCaption.value.trim().slice(0, 240),
    });
    if (insErr) throw insErr;

    els.modalUpload.hidden = true;
    toast('Foto pubblicata!');

    // Invia una copia della foto su Google Drive in background: non si
    // aspetta il risultato, così non rallenta né blocca la pubblicazione.
    backupToDrive(pendingFile, state.guestName, els.inputCaption.value.trim().slice(0, 240));
  } catch (err) {
    els.uploadError.textContent = 'Errore durante il caricamento: ' + (err.message || err);
    els.uploadError.hidden = false;
  } finally {
    els.uploadBtnLabel.hidden = false;
    els.uploadSpinner.hidden = true;
    els.btnSubmitUpload.disabled = false;
  }
});

// ============================================================================
// Backup automatico su Google Drive (facoltativo, non blocca la pubblicazione)
// ============================================================================
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function backupToDrive(blob, authorName, caption) {
  if (!DRIVE_BACKUP_URL) return; // backup non configurato: non fa nulla
  try {
    const base64 = await blobToBase64(blob);
    const safeAuthor = (authorName || 'ospite').replace(/[^a-z0-9]/gi, '_');
    const filename = `${safeAuthor}_${Date.now()}.jpg`;
    // "no-cors": non ci serve leggere la risposta, ci basta tentare l'invio
    // senza far fallire o rallentare la pubblicazione della foto sul sito.
    await fetch(DRIVE_BACKUP_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ imageBase64: base64, mimeType: 'image/jpeg', filename, authorName, caption }),
    });
  } catch (e) {
    // Il backup su Drive è un extra: se fallisce, la foto resta comunque
    // pubblicata regolarmente sul sito.
  }
}

async function deletePost(postId) {
  const entry = state.posts.get(postId);
  if (!entry) return;
  const path = pathFromPublicUrl(entry.data.image_url);
  const { data, error } = await sb.from('posts').delete().eq('id', postId).select('id');
  if (error) { toast('Errore: ' + error.message); return; }
  if (!data || data.length === 0) {
    toast('Eliminazione bloccata: non risulti connesso come amministratore su questo dispositivo.');
    return;
  }
  if (path) await sb.storage.from(BUCKET).remove([path]);
}

// ============================================================================
// News — messaggi di testo pubblici, senza foto e senza archivio personale
// ============================================================================
const tplNews = document.getElementById('tplNews');
const newsState = {
  order: [],        // id in ordine di creazione decrescente
  items: new Map(),  // id -> { data, cardEl }
};

async function loadNews() {
  const { data, error } = await sb
    .from('news')
    .select('id, guest_id, author_name, text, created_at')
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) {
    toast('Impossibile caricare i messaggi: ' + error.message);
    return;
  }
  for (const n of data) addNewsToState(n);
  reflowNews();
}

function addNewsToState(item) {
  if (newsState.items.has(item.id)) return;
  const cardEl = renderNewsCard(item);
  newsState.items.set(item.id, { data: item, cardEl });
  newsState.order.push(item.id);
  newsState.order.sort((a, b) => new Date(newsState.items.get(b).data.created_at) - new Date(newsState.items.get(a).data.created_at));
}

function removeNewsFromState(id) {
  if (!newsState.items.has(id)) return;
  newsState.items.delete(id);
  newsState.order = newsState.order.filter(x => x !== id);
  reflowNews();
}

function reflowNews() {
  els.feedNews.innerHTML = '';
  for (const id of newsState.order) {
    const entry = newsState.items.get(id);
    if (entry?.cardEl) els.feedNews.appendChild(entry.cardEl);
  }
  els.emptyNews.hidden = newsState.order.length > 0;
}

function renderNewsCard(item) {
  const node = tplNews.content.firstElementChild.cloneNode(true);
  node.dataset.newsId = item.id;
  node.querySelector('.news-author').textContent = item.author_name;
  node.querySelector('.news-time').textContent = timeAgo(item.created_at);
  node.querySelector('.news-text').textContent = item.text;

  const delBtn = node.querySelector('.news-delete');
  delBtn.hidden = !state.isAdmin;
  delBtn.addEventListener('click', () => deleteNews(item.id));

  return node;
}

async function submitNews() {
  if (!requireName()) return;
  const text = els.inputNews.value.trim();
  if (!text) return;
  els.inputNews.value = '';
  els.btnSendNews.disabled = true;
  const { error } = await sb.from('news').insert({
    guest_id: state.guestId, author_name: state.guestName, text,
  });
  els.btnSendNews.disabled = false;
  if (error) toast('Impossibile pubblicare il messaggio.');
}

els.btnSendNews.addEventListener('click', submitNews);
els.inputNews.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNews(); }
});

async function deleteNews(id) {
  const { data, error } = await sb.from('news').delete().eq('id', id).select('id');
  if (error) { toast('Errore: ' + error.message); return; }
  if (!data || data.length === 0) {
    toast('Eliminazione bloccata: non risulti connesso come amministratore su questo dispositivo.');
  }
}

// ============================================================================
// Admin
// ============================================================================
document.querySelectorAll('.js-admin-open').forEach(btn => {
  btn.addEventListener('click', () => {
    els.adminError.hidden = true;
    if (state.isAdmin) {
      els.adminLoginForm.hidden = true;
      els.adminLoggedInPanel.hidden = false;
    } else {
      els.adminLoginForm.hidden = false;
      els.adminLoggedInPanel.hidden = true;
      els.inputAdminEmail.value = '';
      els.inputAdminPassword.value = '';
    }
    els.modalAdmin.hidden = false;
  });
});

els.btnCancelAdmin.addEventListener('click', () => { els.modalAdmin.hidden = true; });
els.btnCloseAdminPanel.addEventListener('click', () => { els.modalAdmin.hidden = true; });

els.btnDoLogin.addEventListener('click', async () => {
  const email = els.inputAdminEmail.value.trim();
  const password = els.inputAdminPassword.value;
  if (!email || !password) {
    els.adminError.textContent = 'Inserisci email e password.';
    els.adminError.hidden = false;
    return;
  }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    els.adminError.textContent = 'Accesso non riuscito. Controlla le credenziali.';
    els.adminError.hidden = false;
    return;
  }
  els.modalAdmin.hidden = true;
  toast('Accesso amministratore effettuato.');
});

els.btnLogout.addEventListener('click', async () => {
  await sb.auth.signOut();
  els.modalAdmin.hidden = true;
  toast('Sei uscito dalla modalità amministratore.');
});

sb.auth.onAuthStateChange((_event, session) => {
  setAdminUI(!!session);
  refreshAllAdminButtons();
});

function refreshAllAdminButtons() {
  // Il pulsante elimina foto si vede per l'admin oppure per chi ha pubblicato quella foto.
  for (const entry of state.posts.values()) {
    const delBtn = entry.cardEl?.querySelector('.card-delete');
    if (delBtn) delBtn.hidden = !(state.isAdmin || entry.data.guest_id === state.guestId);
  }
  document.querySelectorAll('.comment-admin-actions').forEach(b => { b.hidden = !state.isAdmin; });
  document.querySelectorAll('.comment-edit-btn, .comment-delete').forEach(b => { b.hidden = !state.isAdmin; });
  document.querySelectorAll('.news-delete').forEach(b => { b.hidden = !state.isAdmin; });
}

// ============================================================================
// Slideshow
// ============================================================================
let slideshowTimer = null;
let slideshowIndex = 0;

els.btnSlideshow.addEventListener('click', startSlideshow);
els.btnCloseSlideshow.addEventListener('click', stopSlideshow);

function startSlideshow() {
  if (state.order.length === 0) { toast('Non ci sono ancora foto da mostrare.'); return; }
  slideshowIndex = 0;
  els.slideshow.hidden = false;
  showSlide();
  slideshowTimer = setInterval(showSlide, 6000);
}

function stopSlideshow() {
  els.slideshow.hidden = true;
  clearInterval(slideshowTimer);
}

function showSlide() {
  if (state.order.length === 0) return;
  slideshowIndex = slideshowIndex % state.order.length;
  const id = state.order[slideshowIndex];
  const entry = state.posts.get(id);
  if (entry) {
    els.slideshowImg.src = entry.data.image_url;
    els.slideshowAuthor.textContent = entry.data.author_name;
    els.slideshowText.textContent = entry.data.caption || '';
  }
  slideshowIndex++;
}

document.addEventListener('keydown', e => {
  if (!els.slideshow.hidden && e.key === 'Escape') stopSlideshow();
});

// ============================================================================
// Esporta archivio foto (solo admin)
// ============================================================================
els.btnExport.addEventListener('click', async () => {
  if (state.order.length === 0) { toast('Non ci sono foto da esportare.'); return; }
  toast('Preparazione dell’archivio…', 60000);
  const zip = new JSZip();
  let i = 0;
  for (const id of state.order) {
    const entry = state.posts.get(id);
    try {
      const res = await fetch(entry.data.image_url);
      const blob = await res.blob();
      const ext = (entry.data.image_url.split('.').pop() || 'jpg').split('?')[0];
      const safeAuthor = entry.data.author_name.replace(/[^a-z0-9]/gi, '_');
      zip.file(`${String(++i).padStart(3, '0')}_${safeAuthor}.${ext}`, blob);
    } catch (e) { /* salta la foto non raggiungibile */ }
  }
  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'melagram-foto.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  els.toast.hidden = true;
  toast('Archivio pronto!');
});

// ============================================================================
// Reset di tutti i profili (solo admin) — cancella nomi/password degli
// ospiti, NON tocca foto, like, commenti o news. Serve a far ripartire da
// zero il login se durante il matrimonio qualcosa nei profili si blocca.
// ============================================================================
els.btnResetProfiles.addEventListener('click', async () => {
  if (!state.isAdmin) { toast('Devi essere connesso come amministratore.'); return; }

  const conferma = window.prompt(
    'Questo cancella TUTTI i profili (nome + password) degli invitati: dovranno rifare la registrazione. Le foto, i like, i commenti e le news NON vengono toccati.\n\nPer confermare scrivi RESET (tutto maiuscolo):'
  );
  if (conferma === null) return;
  if (conferma.trim().toUpperCase() !== 'RESET') {
    toast('Reset annullato.');
    return;
  }

  toast('Reset dei profili in corso…', 15000);
  const { error } = await sb.rpc('reset_all_guests');
  els.toast.hidden = true;
  if (error) {
    toast('Errore: ' + error.message);
    return;
  }

  toast('Tutti i profili sono stati resettati.');
  els.modalAdmin.hidden = true;

  // Anche questo dispositivo deve ripartire da zero con nome/password,
  // dato che il proprio profilo ospite (se ne aveva uno) non esiste più.
  localStorage.removeItem('melagram_guest_id');
  localStorage.removeItem('melagram_guest_name');
  setTimeout(() => window.location.reload(), 1200);
});

// ============================================================================
// Realtime
// ============================================================================
function subscribeRealtime() {
  sb.channel('melagram-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, payload => {
      if (state.posts.has(payload.new.id)) return;
      addPostToState(payload.new, { likeCount: 0, commentCount: 0, likedByMe: false });
      reflowActiveView();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, payload => {
      removePostFromState(payload.old.id);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, payload => {
      const entry = state.posts.get(payload.new.post_id);
      if (!entry) return;
      if (payload.new.guest_id === state.guestId) return;
      entry.likeCount++;
      updateCardLike(payload.new.post_id);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, payload => {
      const entry = state.posts.get(payload.old.post_id);
      if (!entry) return;
      if (payload.old.guest_id === state.guestId) return;
      entry.likeCount = Math.max(0, entry.likeCount - 1);
      updateCardLike(payload.old.post_id);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, payload => {
      const entry = state.posts.get(payload.new.post_id);
      if (!entry) return;
      entry.commentCount++;
      updateCardCommentCount(payload.new.post_id);
      const panel = entry.cardEl?.querySelector('.card-comments');
      if (entry.commentsLoaded && panel && !panel.hidden) {
        panel.querySelector('.comment-list').appendChild(renderComment(payload.new));
      } else if (entry.commentsLoaded) {
        entry.commentsLoaded = false; // ricarica alla prossima apertura
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comments' }, payload => {
      const entry = state.posts.get(payload.new.post_id);
      if (!entry?.cardEl) return;
      const row = entry.cardEl.querySelector(`.comment-row[data-comment-id="${payload.new.id}"]`);
      if (row) row.querySelector('.comment-text').textContent = payload.new.text;
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, payload => {
      const entry = state.posts.get(payload.old.post_id);
      if (!entry) return;
      entry.commentCount = Math.max(0, entry.commentCount - 1);
      updateCardCommentCount(payload.old.post_id);
      const row = entry.cardEl?.querySelector(`.comment-row[data-comment-id="${payload.old.id}"]`);
      row?.remove();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'news' }, payload => {
      addNewsToState(payload.new);
      reflowNews();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'news' }, payload => {
      removeNewsFromState(payload.old.id);
    })
    .subscribe();
}

// ============================================================================
// Banner di installazione PWA (Android: prompt reale; iOS: istruzioni)
// ============================================================================
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function showInstallBanner() {
  if (isStandalone()) return;
  if (localStorage.getItem('melagram_install_dismissed')) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isIOS) {
    els.installText.textContent = 'Aggiungi Melagram alla schermata Home: tocca Condividi ⬆️ qui sotto, poi "Aggiungi a Home".';
    els.btnInstallAction.hidden = true;
  } else if (deferredInstallPrompt) {
    els.installText.textContent = 'Installa Melagram sulla schermata Home per aprirla come un’app.';
    els.btnInstallAction.hidden = false;
  } else {
    return;
  }

  els.installBanner.hidden = false;
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});

els.btnInstallAction.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.installBanner.hidden = true;
  localStorage.setItem('melagram_install_dismissed', '1');
});

els.btnInstallClose.addEventListener('click', () => {
  els.installBanner.hidden = true;
  localStorage.setItem('melagram_install_dismissed', '1');
});

window.addEventListener('appinstalled', () => {
  els.installBanner.hidden = true;
  localStorage.setItem('melagram_install_dismissed', '1');
});

if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
  setTimeout(showInstallBanner, 1500);
}

// ============================================================================
// Avvio
// ============================================================================
(async function init() {
  // Riapre la stessa sezione in cui ci si trovava prima del reload, invece
  // di tornare sempre alla Home.
  const savedView = localStorage.getItem('melagram_active_view');
  switchView(['home', 'news', 'profile'].includes(savedView) ? savedView : 'home');
  loadIdentity();
  const { data: { session } } = await sb.auth.getSession();
  setAdminUI(!!session);
  await loadFeed();
  await loadNews();
  subscribeRealtime();
})();