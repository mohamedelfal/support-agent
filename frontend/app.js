const API = 'https://support-agent-worker.mohamed-elfal.workers.dev/api';
let token = localStorage.getItem('token') || null;
let currentUser = null;

// --- تحديث الواجهة (نسخة مبسطة مع تغيير لون الخلفية) ---
function updateUI() {
    console.log('🔄 updateUI called, token:', token);
    const body = document.body;
    
    if (token) {
        // تغيير لون الخلفية إلى الأخضر الفاتح كدليل مرئي
        body.style.backgroundColor = '#1a3a1a';
        document.getElementById('loginBtn').style.display = 'none';
        document.getElementById('logoutBtn').style.display = 'inline-block';
        
        // إظهار رسالة بسيطة
        const msg = document.getElementById('statusMessage');
        if (msg) {
            msg.style.display = 'block';
            msg.innerHTML = `<h2 style="color:#00b894;">✅ تم تسجيل الدخول بنجاح</h2><p>مرحباً ${currentUser?.email || 'مستخدم'}</p>`;
        }
        
        console.log('✅ UI updated: Logged in');
    } else {
        body.style.backgroundColor = '#0d0d1a';
        document.getElementById('loginBtn').style.display = 'inline-block';
        document.getElementById('logoutBtn').style.display = 'none';
        
        const msg = document.getElementById('statusMessage');
        if (msg) msg.style.display = 'none';
        
        console.log('❌ UI updated: Logged out');
    }
}

// --- تسجيل الدخول ---
async function login() {
    const email = prompt('أدخل بريدك الإلكتروني:');
    if (!email) return;
    
    try {
        console.log('📤 Sending login...');
        const res = await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
        });
        
        const data = await res.json();
        console.log('📥 Response:', data);
        
        if (data.token && data.user) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            updateUI(); // تغيير اللون يحدث هنا
            alert('✅ تم تسجيل الدخول! (انظر تغير لون الخلفية)');
        } else {
            alert('❌ فشل الدخول');
        }
    } catch (e) {
        console.error('❌ Error:', e);
        alert('❌ خطأ في الاتصال');
    }
}

// --- تسجيل الخروج ---
function logout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    updateUI();
}

// --- تهيئة الصفحة ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM loaded');
    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    updateUI();
});

// جعل الدوال عامة
window.login = login;
window.logout = logout;
