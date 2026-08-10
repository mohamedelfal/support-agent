// ============================================================
// وكيل الذكاء الاصطناعي - الواجهة الأمامية
// مع مصادقة البريد الإلكتروني وعزل المحادثات
// ============================================================

const API = 'https://support-agent.mohamed-elfal.workers.dev/api';

// عناصر DOM
const loginSection = document.getElementById('login-section');
const chatSection = document.getElementById('chat-section');
const historySection = document.getElementById('history-section');
const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const loginSubmit = document.getElementById('loginSubmit');
const loginMessage = document.getElementById('loginMessage');
const userEmailDisplay = document.getElementById('userEmailDisplay');
const logoutBtn = document.getElementById('logoutBtn');
const messages = document.getElementById('messages');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const historyList = document.getElementById('history-list');

let token = localStorage.getItem('token');
let currentUser = null;

// --- استدعاء API مع المصادقة ---
async function apiCall(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API}${endpoint}`, {
        ...options,
        headers,
    });

    if (response.status === 401) {
        logout();
        throw new Error('جلسة غير صالحة، يرجى تسجيل الدخول مجدداً');
    }

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || `خطأ ${response.status}`);
    }
    return data;
}

// --- عرض رسالة ---
function showMessage(element, text, type = '') {
    element.textContent = text;
    element.className = type;
}

// --- تسجيل الدخول ---
async function login(email) {
    loginSubmit.disabled = true;
    loginSubmit.textContent = '⏳ جاري...';
    showMessage(loginMessage, '');

    try {
        const data = await apiCall('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email })
        });

        token = data.token;
        currentUser = data.user;
        localStorage.setItem('token', token);
        updateUI();
        loadHistory();
        showMessage(loginMessage, '✅ تم تسجيل الدخول بنجاح', 'success');

    } catch (err) {
        showMessage(loginMessage, '❌ ' + err.message, 'error');
    } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'دخول';
    }
}

// --- تسجيل الخروج ---
function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    updateUI();
    messages.innerHTML = '';
    historyList.innerHTML = '';
}

// --- تحديث الواجهة ---
function updateUI() {
    const isLoggedIn = !!token && !!currentUser;
    loginSection.style.display = isLoggedIn ? 'none' : 'block';
    chatSection.style.display = isLoggedIn ? 'block' : 'none';
    historySection.style.display = isLoggedIn ? 'block' : 'none';
    if (isLoggedIn) {
        userEmailDisplay.textContent = `👋 مرحباً ${currentUser.email}`;
        // رسالة ترحيب في الشات
        if (messages.children.length === 0) {
            appendMessage('👋 مرحباً! اسألني أي شيء وسأجيبك بأفضل ما لدي.', 'assistant');
        }
    }
}

// --- التحقق من الجلسة ---
async function checkSession() {
    try {
        const data = await apiCall('/auth/me');
        currentUser = data.user;
        updateUI();
        loadHistory();
    } catch (e) {
        // غير مسجل دخول
        console.log('Not logged in');
    }
}

// --- إرسال السؤال ---
async function sendQuestion() {
    const question = questionInput.value.trim();
    if (!question) return;

    appendMessage(question, 'user');
    questionInput.value = '';
    sendBtn.disabled = true;

    const loadingMsg = appendMessage('⏳ جاري التفكير...', 'assistant', true);

    try {
        const data = await apiCall('/ask', {
            method: 'POST',
            body: JSON.stringify({ question })
        });

        loadingMsg.remove();
        appendMessage(data.answer || 'لم أستطع الإجابة.', 'assistant');
        loadHistory();

    } catch (error) {
        loadingMsg.remove();
        appendMessage('❌ ' + error.message, 'assistant');
    } finally {
        sendBtn.disabled = false;
        questionInput.focus();
    }
}

// --- إضافة رسالة ---
function appendMessage(text, role, isLoading = false) {
    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    msg.textContent = text;
    if (isLoading) {
        msg.classList.add('loading');
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
}

// --- جلب المحادثات الخاصة ---
async function loadHistory() {
    if (!token) return;
    try {
        const data = await apiCall('/conversations');
        if (!data.conversations || data.conversations.length === 0) {
            historyList.innerHTML = '<p style="color:#666;text-align:center;">لا توجد محادثات سابقة.</p>';
            return;
        }

        historyList.innerHTML = data.conversations.map(conv => `
            <div class="history-item">
                <div class="history-question">❓ ${conv.message}</div>
                <div class="history-answer">💬 ${conv.response}</div>
                <div class="history-time">🕐 ${new Date(conv.created_at).toLocaleString('ar-EG')}</div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Load history error:', error);
        historyList.innerHTML = '<p style="color:#f5576c;text-align:center;">❌ فشل في تحميل المحادثات</p>';
    }
}

// --- الأحداث ---
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) {
        showMessage(loginMessage, '⚠️ يرجى إدخال البريد الإلكتروني', 'error');
        return;
    }
    login(email);
});

logoutBtn.addEventListener('click', logout);
sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendQuestion();
});

// --- بدء التطبيق ---
checkSession();
