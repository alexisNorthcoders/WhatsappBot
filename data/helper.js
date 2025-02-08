function pickRandomTopic(topics) {
    const topicsNumber = topics.length

    const index = Math.floor(Math.random() * topicsNumber)

    return topics[index]
}

module.exports = { pickRandomTopic }
