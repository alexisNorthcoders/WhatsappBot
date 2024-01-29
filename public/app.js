async function sendPrompt() {
    const userPrompt = document.getElementById('userPrompt').value;
    const selectedModel = getSelectedModel()
    let postURL = '/gpt3'
    if (selectedModel === 'gpt-4') {
        postURL = '/gpt4'
    } else if (selectedModel === 'dall-e') {
        postURL = '/dalle'
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
        const reader = response.body.getReader();
        let chunks = '';
        
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            // Process the chunk as needed, you can append it to the existing data
            chunks += new TextDecoder().decode(value);

            // Update UI or perform other actions with the streaming data
            console.log(chunks);
        }

        // When the streaming is complete, you can parse the accumulated data
        const data = JSON.parse(chunks);
        //const data = await response.text();
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

    
    historyDiv.innerText = '';

   
    conversationHistory.forEach(item => {
        const conversationItem = document.createElement('div');
        conversationItem.className = "conversation-item"; 

        const userMessage = document.createElement('div');
        userMessage.innerHTML = `<strong>User: </strong>`;
        userMessage.innerText = `${item.user}`;

        const botMessage = document.createElement('div');
        botMessage.innerHTML = `<strong>Bot: </strong>`;
        botMessage.innerText = `${item.bot}`;

        conversationItem.appendChild(userMessage);
        conversationItem.appendChild(botMessage);

        historyDiv.appendChild(conversationItem);
    });

    window.scrollTo(0, document.body.scrollHeight)
}

function clearConversationHistory() {
    localStorage.removeItem('conversationHistory');
    const historyDiv = document.getElementById('history');
    historyDiv.innerText = ''; 
}
function clearConversation() {
    clearConversationHistory(); 
    displayConversationHistory(); 
}
window.onload = function() {
    displayConversationHistory(); 
}