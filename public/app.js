async function sendPrompt() {
    const userPrompt = document.getElementById('userPrompt').value;
    const selectedModel = getSelectedModel()
    let postURL = '/gpt3'
    if (selectedModel === 'gpt-4') {
        postURL = '/gpt4'
    } else if (selectedModel === 'dall-e-2') {
        postURL = '/dalle2'
    }
    console.log(postURL)
    try {
        const response = await fetch(postURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userPrompt })
        });
        const data = await response.text();
        let conversationHistory = JSON.parse(localStorage.getItem('conversationHistory')) || [];
        conversationHistory.push({ user: userPrompt, bot: data });
        localStorage.setItem('conversationHistory', JSON.stringify(conversationHistory));

        document.getElementById('response').innerText = data;
        displayConversationHistory()
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('response').innerText = 'Error processing message';
    }
}

function retrieveConversationHistory() {
    const conversationHistory = JSON.parse(localStorage.getItem('conversationHistory')) || [];
}
function updateCharacterCount() {
    const textarea = document.getElementById('userPrompt');
    const charCountSpan = document.getElementById('charCount');
    charCountSpan.textContent = textarea.value.length;
}

function getSelectedModel() {
    const radios = document.getElementsByName('model');
    let selectedModel = '';
    radios.forEach((radio) => {
        if (radio.checked) {
            selectedModel = radio.value;
        }
    });
    return selectedModel;
}

function displayConversationHistory() {
    const historyDiv = document.getElementById('history');
    const conversationHistory = JSON.parse(localStorage.getItem('conversationHistory')) || [];

    // Clear previous content before displaying updated history
    historyDiv.innerHTML = '';

    // Loop through conversation history and display each item
    conversationHistory.forEach(item => {
        const conversationItem = document.createElement('div');
        conversationItem.className = "conversation-item"; // Add this line
        conversationItem.innerHTML = `
        <div><strong>User:</strong> ${item.user}</div>
        <div><strong>Bot:</strong> ${item.bot}</div>`;
        historyDiv.appendChild(conversationItem);
        console.log(conversationItem.innerHTML)
        });

    // Scroll to the bottom after updating conversation history
    historyDiv.scrollTop = historyDiv.scrollHeight;
}

window.onload = function() {
    displayConversationHistory(); // Display conversation history on page load
}