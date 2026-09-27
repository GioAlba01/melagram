// ============================================================================
// Melagram — configurazione
// ============================================================================
const SUPABASE_URL = "https://pveifyerzesfnysmoaqd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2ZWlmeWVyemVzZm55c21vYXFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MDEyNjMsImV4cCI6MjEwNjA3NzI2M30.NUbOXAM3CT7hfKFKAiN05JXNJLn1Yx8enIjgbw1a6sc";
const BUCKET = "wedding-photos";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// Stato locale
// ============================================================================
const state = {
  guestId: null,
  guestName: null,
  isAdmin: false,
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

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setAdminUI(isAdmin) {
  state.isAdmin = isAdmin;
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
  state.guestId = localStorage.getItem('melagram_guest_id');
  if (!state.guestId) {
    state.guestId = uuid();
    localStorage.setItem('melagram_guest_id', state.guestId);
  }
  state.guestName = localStorage.getItem('melagram_guest_name');
  els.guestNameLabel.textContent = state.guestName || '…';
  if (!state.guestName) openNameModal();
}

function openNameModal() {
  els.inputName.value = state.guestName || '';
  els.nameError.hidden = true;
  els.modalName.hidden = false;
  setTimeout(() => els.inputName.focus(), 50);
}

els.btnSaveName.addEventListener('click', () => {
  const name = els.inputName.value.trim();
  if (!name) {
    els.nameError.textContent = 'Inserisci il tuo nome.';
    els.nameError.hidden = false;
    return;
  }
  state.guestName = name.slice(0, 40);
  localStorage.setItem('melagram_guest_name', state.guestName);
  els.guestNameLabel.textContent = state.guestName;
  els.modalName.hidden = true;
});

els.inputName.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.btnSaveName.click();
});

els.btnChangeName.addEventListener('click', openNameModal);

function requireName() {
  if (!state.guestName) { openNameModal(); return false; }
  return true;
}

// ============================================================================
// Feed — caricamento iniziale
// ============================================================================
async function loadFeed() {
  const { data: posts, error } = await sb
    .from('posts')
    .select('id, author_name, image_url, caption, created_at, likes(count), comments(count)')
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

  els.feedEmpty.hidden = posts.length > 0;

  for (const p of posts) {
    addPostToState(p, {
      likeCount: p.likes?.[0]?.count || 0,
      commentCount: p.comments?.[0]?.count || 0,
      likedByMe: likedSet.has(p.id),
    }, { prepend: false });
  }
}

function addPostToState(post, counts, { prepend }) {
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
  const card = renderCard(post.id, entry);
  entry.cardEl = card;
  if (prepend) {
    els.feed.insertBefore(card, els.feed.firstChild === els.feedEmpty ? els.feedEmpty.nextSibling : els.feed.firstChild);
    state.order.unshift(post.id);
  } else {
    els.feed.appendChild(card);
    state.order.push(post.id);
  }
  els.feedEmpty.hidden = state.order.length > 0;
}

function removePostFromState(postId) {
  const entry = state.posts.get(postId);
  if (!entry) return;
  entry.cardEl?.remove();
  state.posts.delete(postId);
  state.order = state.order.filter(id => id !== postId);
  els.feedEmpty.hidden = state.order.length > 0;
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
  delBtn.hidden = !state.isAdmin;
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
    .select('id, author_name, text, created_at')
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
  node.querySelector('.comment-author').textContent = c.author_name + ':';
  node.querySelector('.comment-text').textContent = c.text;
  const delBtn = node.querySelector('.comment-delete');
  delBtn.hidden = !state.isAdmin;
  delBtn.addEventListener('click', () => deleteComment(c.id, c.post_id));
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

async function deleteComment(commentId, postId) {
  const { error } = await sb.from('comments').delete().eq('id', commentId);
  if (error) toast('Impossibile eliminare il commento.');
}

// ============================================================================
// Upload foto
// ============================================================================
let pendingFile = null;

els.fab.addEventListener('click', () => {
  if (!requireName()) return;
  pendingFile = null;
  els.inputFile.value = '';
  els.filePreview.hidden = true;
  els.fileDropLabel.hidden = false;
  els.inputCaption.value = '';
  els.uploadError.hidden = true;
  els.modalUpload.hidden = false;
});

els.btnCancelUpload.addEventListener('click', () => { els.modalUpload.hidden = true; });

els.inputFile.addEventListener('change', () => {
  const file = els.inputFile.files[0];
  if (!file) return;
  pendingFile = file;
  const url = URL.createObjectURL(file);
  els.filePreview.src = url;
  els.filePreview.hidden = false;
  els.fileDropLabel.hidden = true;
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
    const ext = (pendingFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${state.guestId}/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;

    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, pendingFile, {
      contentType: pendingFile.type || 'image/jpeg',
    });
    if (upErr) throw upErr;

    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    const imageUrl = pub.publicUrl;

    const { error: insErr } = await sb.from('posts').insert({
      author_name: state.guestName,
      image_url: imageUrl,
      caption: els.inputCaption.value.trim().slice(0, 240),
    });
    if (insErr) throw insErr;

    els.modalUpload.hidden = true;
    toast('Foto pubblicata!');
  } catch (err) {
    els.uploadError.textContent = 'Errore durante il caricamento: ' + (err.message || err);
    els.uploadError.hidden = false;
  } finally {
    els.uploadBtnLabel.hidden = false;
    els.uploadSpinner.hidden = true;
    els.btnSubmitUpload.disabled = false;
  }
});

async function deletePost(postId) {
  const entry = state.posts.get(postId);
  if (!entry) return;
  const path = pathFromPublicUrl(entry.data.image_url);
  const { error } = await sb.from('posts').delete().eq('id', postId);
  if (error) { toast('Impossibile eliminare la foto.'); return; }
  if (path) await sb.storage.from(BUCKET).remove([path]);
}

// ============================================================================
// Admin
// ============================================================================
els.btnAdmin.addEventListener('click', () => {
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
  refreshAllCommentDeleteButtons();
});

function refreshAllCommentDeleteButtons() {
  document.querySelectorAll('.card-delete').forEach(b => { b.hidden = !state.isAdmin; });
  document.querySelectorAll('.comment-delete').forEach(b => { b.hidden = !state.isAdmin; });
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
// Realtime
// ============================================================================
function subscribeRealtime() {
  sb.channel('melagram-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, payload => {
      if (state.posts.has(payload.new.id)) return;
      addPostToState(payload.new, { likeCount: 0, commentCount: 0, likedByMe: false }, { prepend: true });
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, payload => {
      removePostFromState(payload.old.id);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, payload => {
      const entry = state.posts.get(payload.new.post_id);
      if (!entry) return;
      entry.likeCount++;
      if (payload.new.guest_id === state.guestId) entry.likedByMe = true;
      updateCardLike(payload.new.post_id);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, payload => {
      const entry = state.posts.get(payload.old.post_id);
      if (!entry) return;
      entry.likeCount = Math.max(0, entry.likeCount - 1);
      if (payload.old.guest_id === state.guestId) entry.likedByMe = false;
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
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, payload => {
      const entry = state.posts.get(payload.old.post_id);
      if (!entry) return;
      entry.commentCount = Math.max(0, entry.commentCount - 1);
      updateCardCommentCount(payload.old.post_id);
      const row = entry.cardEl?.querySelector(`.comment-row[data-comment-id="${payload.old.id}"]`);
      row?.remove();
    })
    .subscribe();
}

// ============================================================================
// Avvio
// ============================================================================
(async function init() {
  loadIdentity();
  const { data: { session } } = await sb.auth.getSession();
  setAdminUI(!!session);
  await loadFeed();
  subscribeRealtime();
})();