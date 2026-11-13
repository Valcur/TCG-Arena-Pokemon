async function checkEvole() {
    const fromCard = cards.EvolveFrom?.[0]
    const toCard = cards.EvolveTo?.[0]
    if (!fromCard || !toCard) return
    functions.chatLog("{{card}} is evolving...", { card: fromCard })
    functions.chatLog("has evolved into {{card}}", { card: toCard })

    const childIds = fromCard.grouppedCards ?? []
    const groupedById = new Map((cards?._Grouped ?? []).map(c => [c.id, c]))
    const groupedCards = childIds.map(id => groupedById.get(id)).filter(Boolean)

    await functions.updateCards([toCard], { counters: fromCard.counters })
    await functions.updateCards([fromCard], { counters: [{}, {}] })

    const getRank = (card) => {
        const type = functions.getCardData(card)?.type ?? ""
        if (type === "Pokemon") return 2
        if (type.includes("Energy")) return 0
        return 1
    }

    const sortedCards = [...groupedCards].sort((a, b) => getRank(a) - getRank(b))
    const orderedCards = [...sortedCards, fromCard]

    let i = 0
    for (const card of orderedCards) {
        await functions.groupCard(toCard, card, i)
        i += 1
    }
    await functions.hideCards([fromCard], "yes")
    await functions.repositionCards()
}