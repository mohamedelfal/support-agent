// ============================================================
// وكيل الدعم الذكي - التطبيق الرئيسي (نسخة مستقرة)
// ============================================================

const API = 'https://support-agent-worker.mohamed-elfal.workers.dev/api';

// --- الحالة ---
let token = localStorage.getItem('token') || null;
let currentUser = null;

// --- عناصر DOM ---
const $ = (id) => document.getElementById(id);
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const statusMessage = $('statusMessage');
const userEmailEl = $('userEmail');
const chatMessages = $('chatMessages');
const chatInput = $('chatInputField');
const chatSendBtn = $('chatSendBtn');
const ticketsContainer = $('ticketsContainer');
const ticketSubject = $('ticketSubject');
const ticketDescription = $('ticketDescription');
const submitTicketBtn = $('submitTicketBtn');
const ticketStatus = $('ticketStatus');

const sections = ['dashboard', 'new-ticket', 'tickets-list', 'chat-section'].map($);

// --- تحديث الواجهة ---
function updateUI() {
    const isLoggedIn = !!token && !!currentUser;
    document.body.style.backgroundColor = isLoggedIn ? '#1a3a1a' : '#0d0d1a';

    loginBtn.style.display = isLoggedIn ? 'none' : 'inline-block';
    logoutBtn.style.display = isLoggedIn ? 'inline-block' : 'none';

    if (isLoggedIn && currentUser?.email) {
        statusMessage.style.display = 'block';
        userEmailEl.textContent = `👋 مرحباً ${currentUser.email}`;
    } else {
        statusMessage.style.display = 'none';
    }

    sections.forEach(el => {
        if (el) el.style.display = isLoggedIn ? 'block' : 'none';
    });

    // إذا كان مسجلاً دخول، نعرض الترحيب في الشات
    if (isLoggedIn) {
        showSystemMessage('مرحباً! كيف يمكنني مساعدتك اليوم؟');
    }
}

// --- مساعد لعرض رسائل النظام في الشات ---
function showSystemMessage(text) {
    if (!chatMessages) return;
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.textContent = text;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- تنظيف الشات ---
function clearChat() {
    if (chatMessages) {
        chatMessages.innerHTML = '';
    }
}

// --- تسجيل الدخول ---
async function login() {
    const email = prompt('أدخل بريدك الإلكتروني:');
    if (!email || !email.includes('@')) {
        alert('يرجى إدخال بريد إلكتروني صحيح');
        return;
    }

    try {
        const res = await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
        });

        const data = await res.json();

        if (!res.ok) throw new Error(data.error || 'فشل الخادم');

        if (data.token && data.user) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);

            // تنظيف البيانات القديمة
            clearChat();
            updateUI();

            // تحميل البيانات للمستخدم الجديد
            await loadDashboard();
            await loadTickets();
        } else {
            throw new Error('استجابة غير صالحة من الخادم');
        }
    } catch (err) {
        console.error('❌ Login error:', err);
        alert('❌ فشل الدخول: ' + err.message);
    }
}

// --- تسجيل الخروج ---
function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    clearChat();
    updateUI();
    // إعادة تعيين عناصر التذاكر
    if (ticketsContainer) ticketsContainer.innerHTML = '<span style="color:#666;">يرجى تسجيل الدخول</span>';
    if (ticketStatus) ticketStatus.textContent = '';
}

// --- تحميل البيانات ---
async function loadDashboard() {
    if (!token) return;
    try {
        const res = await fetch(`${API}/dashboard`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        $('ticketsCount').textContent = data.openTickets || 0;
        $('resolvedCount').textContent = data.resolvedToday || 0;
        $('avgTime').textContent = data.avgResponseTime || '~2s';
    } catch (e) {
        console.warn('Dashboard load failed:', e);
    }
}

async function loadTickets() {
    if (!token) return;
    try {
        const res = await fetch(`${API}/tickets`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (data.tickets?.length) {
            ticketsContainer.innerHTML = data.tickets.map(t => `
                <div class="ticket-item">
                    <div>
                        <strong>${escapeHtml(t.subject)}</strong>
                        <span style="display:block;font-size:13px;color:#888;">${escapeHtml(t.description?.substring(0,80)||'')}...</span>
                    </div>
                    <div>
                        <span class="status ${t.status}">${t.status}</span>
                        <button onclick="resolveTicket('${t.id}')">✅ حل</button>
                        <button onclick="deleteTicket('${t.id}')">🗑️</button>
                    </div>
                </div>
            `).join('');
        } else {
            ticketsContainer.innerHTML = '<span style="color:#666;">لا توجد تذاكر.</span>';
        }
    } catch (e) {
        console.warn('Tickets load failed:', e);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- دوال التذاكر (تعمل عبر onclick) ---
window.resolveTicket = async function(id) {
    if (!confirm('هل أنت متأكد من حل هذه التذكرة؟')) return;
    try {
        await fetch(`${API}/tickets/${id}/resolve`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        loadTickets();
        loadDashboard();
    } catch (e) {
        alert('❌ فشل حل التذكرة');
    }
};

window.deleteTicket = async function(id) {
    if (!confirm('هل أنت متأكد من حذف هذه التذكرة؟')) return;
    try {
        await fetch(`${API}/tickets/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        loadTickets();
        loadDashboard();
    } catch (e) {
        alert('❌ فشل الحذف');
    }
};

// --- إنشاء تذكرة ---
if (submitTicketBtn) {
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
            await fetch(`${API}/tickets`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ subject, description })
            });
            ticketStatus.className = 'success';
            ticketStatus.textContent = '✅ تم إنشاء التذكرة بنجاح!';
            ticketSubject.value = '';
            ticketDescription.value = '';
            loadTickets();
            loadDashboard();
        } catch (e) {
            ticketStatus.className = 'error';
            ticketStatus.textContent = '❌ فشل الإنشاء';
        } finally {
            submitTicketBtn.disabled = false;
        }
    });
}

// --- محادثة الوكيل (الشات) ---
if (chatSendBtn) {
    chatSendBtn.addEventListener('click', sendMessage);
}

if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
}

async function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;

    // عرض رسالة المستخدم
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.textContent = msg;
    chatMessages.appendChild(userMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    chatInput.value = '';
    chatSendBtn.disabled = true;

    // مؤشر التحميل
    const loading = document.createElement('div');
    loading.className = 'message assistant';
    loading.textContent = '⏳ جاري التفكير...';
    chatMessages.appendChild(loading);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const res = await fetch(`${API}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: msg })
        });

        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        loading.remove();
        const assistantMsg = document.createElement('div');
        assistantMsg.className = 'message assistant';
        assistantMsg.textContent = data.answer || 'لم أستطع الإجابة.';
        chatMessages.appendChild(assistantMsg);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // تحديث لوحة التحكم (قد تتغير الإحصائيات)
        loadDashboard();
    } catch (e) {
        loading.textContent = '❌ خطأ: ' + e.message;
        loading.className = 'message assistant error';
    } finally {
        chatSendBtn.disabled = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// --- تهيئة الصفحة ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM loaded');
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);

    if (token) {
        // نحاول جلب المستخدم (قد نحتاج إلى /me)
        // لكننا سنفترض أن المستخدم موجود
        currentUser = { email: 'مستخدم' };
        updateUI();
        loadDashboard();
        loadTickets();
    } else {
        updateUI();
    }
});
