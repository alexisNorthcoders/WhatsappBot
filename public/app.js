async function sendPrompt() {
    const userPrompt = document.getElementById('userPrompt').value;
    const selectedModel = getSelectedModel()
    let postURL = '/gpt3'
    if (selectedModel === 'gpt-4') {
        postURL = '/gpt4'
    } else if (selectedModel === 'dall-e-2') {
        postURL = '/dalle2'
    }else if (selectedModel === 'gpt-3.5-turbo-instruct') {
        postURL = '/instruct'
    }else if (selectedModel === 'recipe') {
        postURL = '/recipe'
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
        document.getElementById('userPrompt').value = '';
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

        // Create separate elements for user and bot messages
        const userMessage = document.createElement('div');
        userMessage.innerHTML = `<strong>User:</strong> ${item.user}`;

        const botMessage = document.createElement('div');
        botMessage.innerHTML = `<strong>Bot:</strong> ${item.bot}`;

        // Append user and bot messages to conversation item
        conversationItem.appendChild(userMessage);
        conversationItem.appendChild(botMessage);

        // Append conversation item to historyDiv
        historyDiv.appendChild(conversationItem);
    });

    // Scroll to the bottom after updating conversation history
    window.scrollTo(0, document.body.scrollHeight)
}

function clearConversationHistory() {
    localStorage.removeItem('conversationHistory');
    const historyDiv = document.getElementById('history');
    historyDiv.innerHTML = ''; // Clear the displayed history on the page
}
function clearConversation() {
    clearConversationHistory(); // Call the function to clear history
    displayConversationHistory(); // Refresh the displayed history on the page
}
window.onload = function() {
    displayConversationHistory(); // Display conversation history on page load
}