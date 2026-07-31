// app.js
const API = 'https://support-agent-worker.mohamed-elfal.workers.dev/api';
let token = localStorage.getItem('token') || null;
let currentUser = null;

// --- عناصر DOM ---
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const sections = ['dashboard', 'new-ticket', 'tickets-list', 'chat-section'];
const statusMessage = document.getElementById('statusMessage');
const userEmail = document.getElementById('userEmail');

// --- تحديث الواجهة ---
function updateUI() {
    console.log('🔄 updateUI called, token:', token ? 'exists' : 'null');
    
    if (token) {
        // إظهار أزرار الخروج
        loginBtn.style.display = 'none';
        logoutBtn.style.display = 'inline-block';
        
        // إظهار جميع الأقسام
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = 'block';
                console.log(`✅ Showing section: ${id}`);
            }
        });
        
        // إظهار رسالة الترحيب
        statusMessage.style.display = 'block';
        if (currentUser) {
            userEmail.textContent = `👋 مرحباً ${currentUser.email}`;
        }
        
        console.log('✅ UI updated: Logged in');
    } else {
        // إخفاء كل شيء
        loginBtn.style.display = 'inline-block';
        logoutBtn.style.display = 'none';
        
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = 'none';
                console.log(`❌ Hiding section: ${id}`);
            }
        });
        
        statusMessage.style.display = 'none';
        console.log('❌ UI updated: Logged out');
    }
}

// --- تسجيل الدخول ---
async function login() {
    const email = prompt('أدخل بريدك الإلكتروني:');
    if (!email) return;
    
    if (!email.includes('@') || !email.includes('.')) {
        alert('يرجى إدخال بريد إلكتروني صحيح');
        return;
    }
    
    try {
        console.log('📤 Sending login request to:', `${API}/auth/login`);
        const res = await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
        });
        
        console.log('📥 Response status:', res.status);
        const data = await res.json();
        console.log('📥 Response data:', data);
        
        if (data.token) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            console.log('✅ Token saved:', token.substring(0, 20) + '...');
            
            // تحديث الواجهة
            updateUI();
            
            // تحميل البيانات
            await loadDashboard();
            await loadTickets();
            
            alert('✅ تم تسجيل الدخول بنجاح!');
        } else {
            alert('❌ فشل الدخول: ' + (data.error || 'خطأ غير معروف'));
        }
    } catch (e) {
        console.error('❌ Login error:', e);
        alert('❌ خطأ في الاتصال بالخادم: ' + e.message);
    }
}

// --- تسجيل الخروج ---
function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    updateUI();
    alert('✅ تم تسجيل الخروج');
}

// --- استدعاء API موحد ---
async function apiCall(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API}${endpoint}`, {
        ...options,
        headers,
    });

    if (res.status === 429) {
        const data = await res.json();
        alert(`طلبات كثيرة جداً. حاول مرة أخرى بعد ${data.retryAfter || 30} ثانية`);
        throw new Error('Rate limited');
    }

    if (res.status === 401) {
        logout();
        throw new Error('جلسة غير صالحة، يرجى تسجيل الدخول مجدداً');
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `خطأ ${res.status}`);
    }

    return res.json();
}

// --- لوحة التحكم ---
async function loadDashboard() {
    try {
        const data = await apiCall('/dashboard');
        document.getElementById('ticketsCount').textContent = data.openTickets || 0;
        document.getElementById('resolvedCount').textContent = data.resolvedToday || 0;
        document.getElementById('avgTime').textContent = data.avgResponseTime || '~2s';
        console.log('📊 Dashboard loaded:', data);
    } catch (e) {
        console.error('❌ Dashboard error:', e);
    }
}

// --- التذاكر ---
async function loadTickets() {
    try {
        const data = await apiCall('/tickets');
        const container = document.getElementById('ticketsContainer');
        if (data.tickets?.length) {
            container.innerHTML = data.tickets.map(t => `
                <div class="ticket-item">
                    <div style="flex:1;min-width:150px;">
                        <strong>${escapeHtml(t.subject)}</strong>
                        <span style="font-size:13px;color:#888;display:block;">${escapeHtml(t.description?.substring(0, 80) || '')}...</span>
                    </div>
                    <div>
                        <span class="status ${t.status}">${t.status}</span>
                        <div class="actions">
                            ${t.status === 'open' ? `<button onclick="resolveTicket('${t.id}')">✅ حل</button>` : ''}
                            <button onclick="deleteTicket('${t.id}')">🗑️</button>
                        </div>
                    </div>
                </div>
            `).join('');
            console.log('📋 Tickets loaded:', data.tickets.length);
        } else {
            container.innerHTML = '<span style="color:#666;">لا توجد تذاكر.</span>';
        }
    } catch (e) {
        console.error('❌ Tickets error:', e);
        document.getElementById('ticketsContainer').innerHTML =
            '<span class="error">فشل تحميل التذاكر</span>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function resolveTicket(id) {
    if (!confirm('هل أنت متأكد من حل هذه التذكرة؟')) return;
    try {
        await apiCall(`/tickets/${id}/resolve`, { method: 'PUT' });
        loadTickets();
        loadDashboard();
    } catch (e) {
        alert('❌ فشل حل التذكرة: ' + e.message);
    }
}

async function deleteTicket(id) {
    if (!confirm('هل أنت متأكد من حذف هذه التذكرة؟')) return;
    try {
        await apiCall(`/tickets/${id}`, { method: 'DELETE' });
        loadTickets();
        loadDashboard();
    } catch (e) {
        alert('❌ فشل الحذف: ' + e.message);
    }
}

// --- إنشاء تذكرة ---
document.getElementById('submitTicketBtn').addEventListener('click', async () => {
    const subject = document.getElementById('ticketSubject').value.trim();
    const description = document.getElementById('ticketDescription').value.trim();
    const status = document.getElementById('ticketStatus');

    if (!subject || subject.length < 3) {
        status.className = 'error';
        status.textContent = '⚠️ العنوان يجب أن يكون 3 أحرف على الأقل';
        return;
    }
    if (!description || description.length < 10) {
        status.className = 'error';
        status.textContent = '⚠️ الوصف يجب أن يكون 10 أحرف على الأقل';
        return;
    }

    const btn = document.getElementById('submitTicketBtn');
    btn.disabled = true;
    status.className = '';

    try {
        const res = await apiCall('/tickets', {
            method: 'POST',
            body: JSON.stringify({ subject, description }),
        });
        status.className = 'success';
        status.textContent = '✅ تم إنشاء التذكرة بنجاح!';
        document.getElementById('ticketSubject').value = '';
        document.getElementById('ticketDescription').value = '';
        loadTickets();
        loadDashboard();
    } catch (e) {
        status.className = 'error';
        status.textContent = '❌ فشل الإنشاء: ' + e.message;
    } finally {
        btn.disabled = false;
    }
});

// --- محادثة الوكيل ---
document.getElementById('chatSendBtn').addEventListener('click', async () => {
    const input = document.getElementById('chatInputField');
    const msg = input.value.trim();
    if (!msg) return;
    if (msg.length > 500) {
        alert('الرسالة طويلة جداً (الحد الأقصى 500 حرف)');
        return;
    }

    input.value = '';
    const btn = document.getElementById('chatSendBtn');
    btn.disabled = true;

    const container = document.getElementById('chatMessages');
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
        const res = await apiCall('/chat', {
            method: 'POST',
            body: JSON.stringify({ message: msg }),
        });

        loading.remove();
        const assistant = document.createElement('div');
        assistant.className = 'message assistant';
        assistant.innerHTML = escapeHtml(res.answer || 'لم أستطع الإجابة.');
        if (res.sources?.length) {
            const src = document.createElement('div');
            src.className = 'sources';
            src.textContent = '📖 المصادر: ' + res.sources.join(' | ');
            assistant.appendChild(src);
        }
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

document.getElementById('chatInputField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('chatSendBtn').click();
});

// --- الأحداث الرئيسية ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM loaded');
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);
    updateUI();
    if (token) {
        loadDashboard();
        loadTickets();
    }
});

// جعل الدوال عامة للاستخدام في onclick
window.resolveTicket = resolveTicket;
window.deleteTicket = deleteTicket;
