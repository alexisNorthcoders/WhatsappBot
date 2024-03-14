const colours = ['red', 'blue', 'green', 'yellow'];

let randomSequence;
let score = 0;
let isGameOver = false;
let blockButtons = true;
let n = 0;

const redButton = document.getElementById('red');
const blueButton = document.getElementById('blue');
const greenButton = document.getElementById('green');
const yellowButton = document.getElementById('yellow');
const startButton = document.getElementById('start');
const gameRound = document.getElementById('round');
const scoreBox = document.getElementById('score');
const highest = document.getElementById('highscore');
const messages = document.getElementById('messages');
const game = document.getElementById('game');
const buttons = document.getElementsByClassName('buttons');

startButton.addEventListener('click', () => startGame());
greenButton.addEventListener('click', () => pushColour('green'));
redButton.addEventListener('click', () => pushColour('red'));
yellowButton.addEventListener('click', () => pushColour('yellow'));
blueButton.addEventListener('click', () => pushColour('blue'));

if (localStorage.highscore) {
    highest.innerText = `${localStorage.highscore}`;
}
buttons[0].style.opacity = '20%';
buttons[1].style.opacity = '20%';

const startGame = () => {
    buttons[0].style.opacity = '100%';
    buttons[1].style.opacity = '100%';
    console.log("starting game");
    isGameOver = false;
    messages.innerText = "";
    messages.style.color = "white";
    gameRound.innerText = 1;
    startButton.disabled = true;
    game.style.display = 'initial';
    countdown(3, () => {
        randomSequence = createSequence(colours, gameRound.innerText);
        showSequence(randomSequence);
    });


};
const countdown = (seconds, callback) => {
    let currentCount = seconds;
    const color = ["green", "yellow", "red"];
    const countdownInterval = setInterval(() => {
        messages.style.color = color[currentCount - 1];
        messages.innerText = currentCount;
        currentCount--;

        if (currentCount < 0) {
            clearInterval(countdownInterval);
            messages.innerText = "";
            callback();
        }
    }, 1000);
};
const nextRound = () => {
    n = 0;
    gameRound.innerText++;
    blockButtons = true;
    randomSequence = createSequence(colours, gameRound.innerText);
    showSequence(randomSequence);
};
const showSequence = (sequence) => {
    messages.style.color = "yellow";
    messages.innerText = "WAIT";
    sequence.forEach((colour, index) => {
        setTimeout(() => {
            highlightButton(colour);
            if (index === sequence.length - 1) {
                messages.style.color = "GREEN";
                messages.innerText = "PLAY";
                blockButtons = false;
            }
        }, index * 1000);
    });
};
const createSequence = (colours, number) => {
    const randomSequence = [];

    for (let i = 0; i < number; i++) {
        const randomIndex = Math.floor(Math.random() * colours.length);
        const randomColour = colours[randomIndex];
        randomSequence.push(randomColour);
    }

    return randomSequence;
};
const pushColour = (colour) => {
    if (blockButtons === true) {
        return;
    }
    console.log(`clicked on ${colour}`);

    if (colour === randomSequence[n]) {
        score++;
        n++;

        if (!localStorage.highscore) {
            localStorage.setItem('highscore', score);
        }
        if (score > localStorage.highscore) {
            localStorage.setItem('highscore', score);
        }
        highest.innerText = `${localStorage.highscore}`;
        scoreBox.innerText = `${score}`;

        if ((n) === randomSequence.length) {
            console.log("next round");
            nextRound();
        }
    }
    else {
        gameOver();
    }
};
const highlightButton = (buttonId) => {
    const button = document.getElementById(buttonId);
    const buttonColour = getComputedStyle(button).backgroundColor;
    button.style.boxShadow = `0 0 50px ${buttonColour}`;
    setTimeout(() => {
        button.style.boxShadow = 'none';
    }, 800);
};
const gameOver = () => {
    blockButtons = true;
    messages.style.color = "red";
    messages.innerText = "GAME OVER";
    startButton.disabled = false;
    score = 0;
    n = 0;
    buttons[0].style.opacity = '20%';
    buttons[1].style.opacity = '20%';

}



