// ============================================================
// الواجهة الأمامية - الإصدار 3.1
// ============================================================

// 
const API = 'https://support-agent.mohamed-elfal.workers.dev/api/v1';

let token = null;
let currentUser = null;

// --- عناصر DOM ---
const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const loginSubmit = document.getElementById('loginSubmit');
const loginMessage = document.getElementById('loginMessage');
const userEmailDisplay = document.getElementById('userEmailDisplay');
const logoutBtn = document.getElementById('logoutBtn');
const ticketsContainer = document.getElementById('ticketsContainer');
const ticketSubject = document.getElementById('ticketSubject');
const ticketDescription = document.getElementById('ticketDescription');
const submitTicketBtn = document.getElementById('submitTicketBtn');
const ticketStatus = document.getElementById('ticketStatus');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInputField');
const chatSendBtn = document.getElementById('chatSendBtn');

async function apiCall(endpoint, options = {}) {
    const res = await fetch(`${API}${endpoint}`, {
        ...options,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (res.status === 401) {
        logout();
        throw new Error('جلسة غير صالحة، يرجى تسجيل الدخول مجدداً');
    }

    const data = await res.json();
    if (!data.success) {
        throw new Error(data.error || 'خطأ غير معروف');
    }
    return data.data;
}

function updateUI() {
    const isLoggedIn = !!token && !!currentUser;
    loginSection.style.display = isLoggedIn ? 'none' : 'block';
    dashboardSection.style.display = isLoggedIn ? 'block' : 'none';
    if (isLoggedIn) {
        userEmailDisplay.textContent = `👋 مرحباً ${currentUser.email}`;
    }
}

function showMessage(element, text, type = '') {
    element.textContent = text;
    element.className = type;
}

async function login(email) {
    loginSubmit.disabled = true;
    loginSubmit.textContent = '⏳ جاري...';
    showMessage(loginMessage, '');

    try {
        const data = await apiCall('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email })
        });

        if (data.requiresOTP) {
            const code = prompt('أدخل رمز OTP المرسل إلى بريدك الإلكتروني:');
            if (!code) {
                throw new Error('OTP مطلوب');
            }

            const verifyData = await apiCall('/auth/verify-otp', {
                method: 'POST',
                body: JSON.stringify({
                    email,
                    code,
                    challengeId: data.challengeId
                })
            });

            token = verifyData.accessToken;
            currentUser = verifyData.user;
            localStorage.setItem('token', token);
            updateUI();
            await loadTickets();
            showMessage(loginMessage, '✅ تم تسجيل الدخول بنجاح', 'success');
            return;
        }

        token = data.accessToken;
        currentUser = data.user;
        localStorage.setItem('token', token);
        updateUI();
        await loadTickets();
        showMessage(loginMessage, '✅ تم تسجيل الدخول بنجاح', 'success');

    } catch (err) {
        showMessage(loginMessage, '❌ ' + err.message, 'error');
    } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'دخول';
    }
}

async function logout() {
    try {
        await apiCall('/auth/logout', { method: 'POST' });
    } catch (e) {}

    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    updateUI();
    loginForm.reset();
    ticketsContainer.innerHTML = '';
    chatMessages.innerHTML = '';
}

async function loadTickets() {
    try {
        const tickets = await apiCall('/tickets');
        if (tickets.length === 0) {
            ticketsContainer.innerHTML = '<span style="color:#666;">لا توجد تذاكر.</span>';
            return;
        }

        ticketsContainer.innerHTML = tickets.map(t => `
            <div class="ticket-item">
                <div>
                    <strong>${escapeHtml(t.subject)}</strong>
                    <span style="display:block;font-size:13px;color:#888;">${escapeHtml(t.description?.substring(0, 80) || '')}...</span>
                </div>
                <div>
                    <span class="status ${t.status}">${t.status}</span>
                    <button onclick="resolveTicket('${t.id}')">✅ حل</button>
                    <button onclick="deleteTicket('${t.id}')">🗑️</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load tickets:', e);
    }
}

window.resolveTicket = async function(id) {
    if (!confirm('هل أنت متأكد من حل هذه التذكرة؟')) return;
    try {
        await apiCall(`/tickets/${id}/resolve`, { method: 'PUT' });
        await loadTickets();
    } catch (e) {
        alert('❌ فشل حل التذكرة: ' + e.message);
    }
};

window.deleteTicket = async function(id) {
    if (!confirm('هل أنت متأكد من حذف هذه التذكرة؟')) return;
    try {
        await apiCall(`/tickets/${id}`, { method: 'DELETE' });
        await loadTickets();
    } catch (e) {
        alert('❌ فشل الحذف: ' + e.message);
    }
};

submitTicketBtn.addEventListener('click', async () => {
    const subject = ticketSubject.value.trim();
    const description = ticketDescription.value.trim();

    if (subject.length < 3) {
        ticketStatus.className = 'error';
        ticketStatus.textContent = '⚠️ العنوان يجب أن يكون 3 أحرف على الأقل';
        return;
    }
    if (description.length < 10) {
        ticketStatus.className = 'error';
        ticketStatus.textContent = '⚠️ الوصف يجب أن يكون 10 أحرف على الأقل';
        return;
    }

    submitTicketBtn.disabled = true;
    ticketStatus.className = '';

    try {
        await apiCall('/tickets', {
            method: 'POST',
            body: JSON.stringify({ subject, description })
        });
        ticketStatus.className = 'success';
        ticketStatus.textContent = '✅ تم إنشاء التذكرة بنجاح!';
        ticketSubject.value = '';
        ticketDescription.value = '';
        await loadTickets();
    } catch (e) {
        ticketStatus.className = 'error';
        ticketStatus.textContent = '❌ فشل الإنشاء: ' + e.message;
    } finally {
        submitTicketBtn.disabled = false;
    }
});

chatSendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
});

async function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;

    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.textContent = msg;
    chatMessages.appendChild(userMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    chatInput.value = '';
    chatSendBtn.disabled = true;

    const loading = document.createElement('div');
    loading.className = 'message assistant';
    loading.textContent = '⏳ جاري التفكير...';
    chatMessages.appendChild(loading);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const data = await apiCall('/chat', {
            method: 'POST',
            body: JSON.stringify({ message: msg })
        });

        loading.remove();
        const assistantMsg = document.createElement('div');
        assistantMsg.className = 'message assistant';
        assistantMsg.textContent = data.answer || 'لم أستطع الإجابة.';
        chatMessages.appendChild(assistantMsg);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } catch (e) {
        loading.textContent = '❌ خطأ: ' + e.message;
        loading.className = 'message assistant error';
    } finally {
        chatSendBtn.disabled = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const data = await apiCall('/me');
        token = localStorage.getItem('token');
        currentUser = data;
        updateUI();
        await loadTickets();
    } catch (e) {}

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
});
