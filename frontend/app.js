// ============================================================
// وكيل الذكاء الاصطناعي - الواجهة الأمامية
// ============================================================

// الرابط المتوقع للـ Worker بعد النشر
const API = 'https://support-agent.mohamed-elfal.workers.dev/api';

// عناصر DOM
const messages = document.getElementById('messages');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');

// --- إرسال السؤال ---
async function sendQuestion() {
    const question = questionInput.value.trim();
    if (!question) return;

    // عرض سؤال المستخدم
    appendMessage(question, 'user');
    questionInput.value = '';
    sendBtn.disabled = true;

    // مؤشر التحميل
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

// --- الأحداث ---
sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendQuestion();
});

// --- رسالة ترحيب ---
appendMessage('👋 مرحباً! اسألني أي شيء وسأجيبك بأفضل ما لدي.', 'assistant');
