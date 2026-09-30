// Shared General News category guard. Headline intent takes precedence over
// incidental words in summaries and over an RSS feed's default category.
// Deliberately conservative: ambiguous articles retain their existing category.
const ALLOWED = new Set(['us', 'politics', 'business', 'technology', 'entertainment', 'sports']);

export function classifyGeneralNewsCategory(title, description = '', feedCategory = 'us') {
  const h = String(title || '').toLowerCase().replace(/[’‘]/g, "'");
  const d = String(description || '').toLowerCase().replace(/[’‘]/g, "'");
  const feed = ALLOWED.has(feedCategory) ? feedCategory : 'us';
  if (!h.trim()) return feed;

  // An explicitly governmental/legal event is not a sports/entertainment
  // story because a game, player or Hollywood job is mentioned in passing.
  const mayoralEvent = /\b(mayor|mayoral)\b/.test(h) &&
    /\b(candidates?|forum|election|race|debate|council|policy|plan)\b/.test(h);
  const senatorLegalEvent = /\b(jack smith|fani willis|schmitt)\b/.test(h) &&
    /\b(perjur(?:y|ed)?|testif(?:y|ied)|investigat(?:e|ion)|attempt to link|hearing|alleg(?:e|ed|ation)|prosecut(?:or|ion))\b/.test(h);
  const legislativeEvent = /\b(senate|senator|congress|lawmakers?|democrats?|republicans?|house of representatives|legislatur(?:e|es))\b/.test(h) &&
    /\b(bill|vote|voting|passes?|blocks?|legislat(?:ion|ive)|committee|hearing|impeach(?:ment)?|propos(?:al|e|ed)|election|campaign)\b/.test(h);
  const electoralEvent = /\b(election|electoral|ballot|voters?|midterm|mayoral race|presidential race|campaign)\b/.test(h) &&
    /\b(candidate|senate|house|congress|president|mayor|governor|party|vote|poll|race|lawmakers?)\b/.test(h);
  const highCourtEvent = /\b(supreme court|federal appeals court|appeals court)\b/.test(h) ||
    (/\b(court|judge)\b/.test(h) && /\b(administration|mayor|mamdani|federal|trump|election|tax|deportation|government|policy|law)\b/.test(h));
  const foreignPolicyEvent = (/\b(troops?|military|soldiers?|pentagon)\b/.test(h) &&
    /\b(iraq|iran|withdraw(?:al|ing)?|pulling|deployment|pullout)\b/.test(h)) ||
    (/\b(iran|nuclear deal|negotiator)\b/.test(h) && /\b(nuclear|deal|negotiat(?:or|ion|e)|proposal|talks|diplomat(?:ic|s)?)\b/.test(h));
  const explicitPolicyEvent = /\b(executive order|state department|legislation|foreign policy|government shutdown|congressional)\b/.test(h) &&
    !/\b(ai|a\.i\.|artificial intelligence|software|openai|chatbot)\b/.test(h);
  if (mayoralEvent || senatorLegalEvent || legislativeEvent || electoralEvent || highCourtEvent || foreignPolicyEvent || explicitPolicyEvent) {
    return 'politics';
  }

  // A specific focus in the HEADLINE takes priority. Avoid broad 'app', 'team',
  // 'market', or 'federal' keywords that regularly misclassify unrelated news.
  if (/\b(ai|a\.i\.|artificial intelligence|openai|chatbot|software|cybersecurity|data breach|semiconductor|smartphone|machine learning|data cent(?:er|re)|technology|tech firms?|tech companies|tech executives|robotics?)\b/.test(h)) {
    return 'technology';
  }
  if (/\b(tariffs?|stocks?|shares?|wall street|nasdaq|s&p 500|inflation|interest rates?|federal reserve|economic|economy|earnings?|quarterly revenue|ipo|bankruptcy|merger|acquisition|investors?|trade deal|business)\b/.test(h)) {
    return 'business';
  }
  if (/\b(film|movies?|actor|actress|celebrity|album|concert|music|musician|hollywood|grammys?|oscars?|netflix|disney|spotify|box office|tv show|television|harry styles|taylor swift|jimmy fallon|streaming series)\b/.test(h)) {
    return 'entertainment';
  }
  if (/\b(nfl|nba|wnba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|olympics?|playoffs?|championship|training camp|wizards|super bowl|world series|tournament)\b/.test(h)) {
    return 'sports';
  }
  if (/\b(shooting|shot|homicide|murder|arrest(?:ed|s)?|charged|assault|terror(?:ism|ist)?|explosion|measles|flood|wildfire|university|school|college|hospital|police|sheriff|missing person|public health)\b/.test(h)) {
    return 'us';
  }

  // An irrelevant word buried in the feed summary is insufficient to override
  // the feed. Exception: known off-topic feeds reporting crimes/public safety.
  if (['entertainment', 'sports'].includes(feed) &&
      /\b(murder|homicide|terror(?:ism|ist)?|assault|arrest(?:ed|s)?|prosecutor|indictment|public safety|shooting|charged with)\b/.test(h + ' ' + d)) {
    return 'us';
  }
  return feed;
}
