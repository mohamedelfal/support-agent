// ============================================================
// وكيل الذكاء الاصطناعي - الواجهة الأمامية
// مع دعم عرض المحادثات السابقة
// ============================================================

const API = 'https://support-agent.mohamed-elfal.workers.dev/api';

// عناصر DOM
const messages = document.getElementById('messages');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const historyList = document.getElementById('history-list');

// --- إرسال السؤال ---
async function sendQuestion() {
    const question = questionInput.value.trim();
    if (!question) return;

    appendMessage(question, 'user');
    questionInput.value = '';
    sendBtn.disabled = true;

    const loadingMsg = appendMessage('⏳ جاري التفكير...', 'assistant', true);

    try {
        const response = await fetch(`${API}/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
        });

        if (!response.ok) {
            let errorText;
            try {
                const errorData = await response.json();
                errorText = errorData.error || `خطأ ${response.status}`;
            } catch {
                errorText = await response.text() || `خطأ ${response.status}`;
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        loadingMsg.remove();
        appendMessage(data.answer || 'لم أستطع الإجابة.', 'assistant');

        // تحديث قائمة المحادثات بعد الإجابة
        loadHistory();

    } catch (error) {
        loadingMsg.remove();
        console.error('Fetch error:', error);
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

// --- جلب المحادثات السابقة ---
async function loadHistory() {
    try {
        const response = await fetch(`${API}/conversations`);
        if (!response.ok) {
            throw new Error('فشل في جلب المحادثات');
        }
        const data = await response.json();
        
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
sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendQuestion();
});

// --- رسالة ترحيب ---
appendMessage('👋 مرحباً! اسألني أي شيء وسأجيبك بأفضل ما لدي.', 'assistant');

// --- تحميل المحادثات عند بدء الصفحة ---
loadHistory();
