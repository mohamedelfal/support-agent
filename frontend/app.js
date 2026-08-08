// ============================================================
// وكيل الذكاء الاصطناعي - الواجهة الأمامية
// ============================================================

// الرابط النسبي (لأن Pages و Worker سيخدمان من نفس النطاق)
const API = '/api';

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
            const error = await response.json();
            throw new Error(error.error || 'خطأ في الخادم');
        }

        const data = await response.json();
        // إزالة مؤشر التحميل
        loadingMsg.remove();
        // عرض الإجابة
        appendMessage(data.answer || 'لم أستطع الإجابة على هذا السؤال.', 'assistant');

    } catch (error) {
        loadingMsg.remove();
        appendMessage('❌ ' + error.message, 'assistant');
    } finally {
        sendBtn.disabled = false;
        questionInput.focus();
    }
}

// --- إضافة رسالة إلى المحادثة ---
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
