export function pickRandomTopic(topics: string[]) {
    const topicsNumber = topics.length

    const index = Math.floor(Math.random() * topicsNumber)

    return topics[index]
}
