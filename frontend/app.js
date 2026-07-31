// ============================================================
// وكيل الدعم الذكي - التطبيق الرئيسي
// ============================================================

const API = 'https://support-agent-worker.mohamed-elfal.workers.dev/api';

// --- الحالة ---
let token = localStorage.getItem('token') || null;
let currentUser = null;

// --- عناصر DOM (مرجع واحد) ---
const $ = (id) => document.getElementById(id);
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const statusMessage = $('statusMessage');
const userEmailEl = $('userEmail');
const sections = ['dashboard', 'new-ticket', 'tickets-list', 'chat-section'].map($);

// --- تحديث الواجهة (الدالة الوحيدة المسؤولة) ---
function updateUI() {
    const isLoggedIn = !!token && !!currentUser;
    console.log(`🔄 updateUI | loggedIn: ${isLoggedIn}, token: ${!!token}, user: ${!!currentUser}`);

    // 1. لون الخلفية
    document.body.style.backgroundColor = isLoggedIn ? '#1a3a1a' : '#0d0d1a';

    // 2. الأزرار
    loginBtn.style.display = isLoggedIn ? 'none' : 'inline-block';
    logoutBtn.style.display = isLoggedIn ? 'inline-block' : 'none';

    // 3. رسالة الترحيب
    if (isLoggedIn && currentUser?.email) {
        statusMessage.style.display = 'block';
        userEmailEl.textContent = `👋 مرحباً ${currentUser.email}`;
    } else {
        statusMessage.style.display = 'none';
    }

    // 4. الأقسام
    sections.forEach(el => {
        if (el) el.style.display = isLoggedIn ? 'block' : 'none';
    });
}

// --- تسجيل الدخول ---
async function login() {
    const email = prompt('أدخل بريدك الإلكتروني:');
    if (!email || !email.includes('@')) {
        alert('يرجى إدخال بريد إلكتروني صحيح');
        return;
    }

    try {
        console.log('📤 login request sent');
        const res = await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
        });

        const data = await res.json();
        console.log('📥 login response:', data);

        if (!res.ok) throw new Error(data.error || 'فشل الخادم');

        if (data.token && data.user) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            updateUI();
            // تحميل البيانات (غير ضروري لظهور الواجهة)
            // لكننا نستدعيه في الخلفية
            loadDashboard().catch(() => {});
            loadTickets().catch(() => {});
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
    console.log('🚪 logout called');
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    updateUI();
}

// --- تحميل البيانات (دوال منفصلة) ---
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
        const container = $('ticketsContainer');
        if (data.tickets?.length) {
            container.innerHTML = data.tickets.map(t => `
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
            container.innerHTML = '<span style="color:#666;">لا توجد تذاكر.</span>';
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

// --- دوال التذاكر (تُستدعى من onclick) ---
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

// --- أحداث الأزرار ---
$('submitTicketBtn')?.addEventListener('click', async () => {
    const subject = $('ticketSubject').value.trim();
    const description = $('ticketDescription').value.trim();
    const status = $('ticketStatus');

    if (subject.length < 3) {
        status.className = 'error';
        status.textContent = '⚠️ العنوان يجب أن يكون 3 أحرف على الأقل';
        return;
    }
    if (description.length < 10) {
        status.className = 'error';
        status.textContent = '⚠️ الوصف يجب أن يكون 10 أحرف على الأقل';
        return;
    }

    const btn = $('submitTicketBtn');
    btn.disabled = true;
    status.className = '';

    try {
        await fetch(`${API}/tickets`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ subject, description })
        });
        status.className = 'success';
        status.textContent = '✅ تم إنشاء التذكرة بنجاح!';
        $('ticketSubject').value = '';
        $('ticketDescription').value = '';
        loadTickets();
        loadDashboard();
    } catch (e) {
        status.className = 'error';
        status.textContent = '❌ فشل الإنشاء';
    } finally {
        btn.disabled = false;
    }
});

$('chatSendBtn')?.addEventListener('click', async () => {
    const input = $('chatInputField');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    const btn = $('chatSendBtn');
    btn.disabled = true;
    const container = $('chatMessages');

    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.textContent = msg;
    container.appendChild(userMsg);

    const loading = document.createElement('div');
    loading.className = 'message assistant';
    loading.textContent = '⏳ جاري التفكير...';
    container.appendChild(loading);
    container.scrollTop = container.scrollHeight;

    try {
        const res = await fetch(`${API}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        loading.remove();
        const assistant = document.createElement('div');
        assistant.className = 'message assistant';
        assistant.innerHTML = escapeHtml(data.answer || 'لم أستطع الإجابة.');
        container.appendChild(assistant);
        loadDashboard();
    } catch (e) {
        loading.textContent = '❌ خطأ: ' + e.message;
        loading.className = 'message assistant error';
    } finally {
        btn.disabled = false;
        container.scrollTop = container.scrollHeight;
    }
});

$('chatInputField')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('chatSendBtn')?.click();
});

// --- تهيئة الصفحة ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM loaded');
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);

    // إذا كان هناك توكن مخزن، نحاول جلب المستخدم
    if (token) {
        // نضع user مؤقتاً (يمكن تحسينه بطلب /me)
        currentUser = { email: 'مستخدم' };
        updateUI();
        loadDashboard();
        loadTickets();
    } else {
        updateUI();
    }
});
