/* Question bank, kept on the server so answers never reach the browser before a reveal.
   Each match draws one question per tier, so a round always climbs Easy -> Medium -> Hard.
   `correct` indexes into `a`. Answers are shuffled when a round is built. */

const TIERS = [
  { name: "Easy", cls: "easy", questions: [
    { q: "Which country won the 2022 FIFA World Cup?", a: ["France", "Argentina", "Brazil", "Croatia"], correct: 1 },
    { q: "Which superstar is nicknamed 'CR7'?", a: ["Cristiano Ronaldo", "Ronaldinho", "Cesc Fabregas", "Carlos Tevez"], correct: 0 },
    { q: "Which club plays its home games at Old Trafford?", a: ["Liverpool", "Manchester City", "Manchester United", "Everton"], correct: 2 },
    { q: "Which nation has won the most men's World Cups?", a: ["Germany", "Brazil", "Italy", "Argentina"], correct: 1 },
    { q: "How many players does each team have on the pitch at kick-off?", a: ["9", "10", "11", "12"], correct: 2 },
    { q: "Which club plays its home games at Camp Nou?", a: ["Real Madrid", "Barcelona", "Atletico Madrid", "Valencia"], correct: 1 },
    { q: "Which country does Lionel Messi play for?", a: ["Spain", "Uruguay", "Argentina", "Chile"], correct: 2 },
    { q: "What colour card does a referee show to send a player off?", a: ["Yellow", "Red", "Blue", "Green"], correct: 1 },
    { q: "Which club is nicknamed 'the Red Devils'?", a: ["Liverpool", "Arsenal", "Manchester United", "AC Milan"], correct: 2 },
    { q: "Which country hosted the 2014 FIFA World Cup?", a: ["Brazil", "South Africa", "Germany", "Russia"], correct: 0 },
    { q: "Anfield is the home ground of which club?", a: ["Everton", "Liverpool", "Leeds United", "Newcastle United"], correct: 1 },
    { q: "How long is a standard professional match, not counting stoppage time?", a: ["60 minutes", "80 minutes", "90 minutes", "100 minutes"], correct: 2 },
    { q: "Which club plays at the Santiago Bernabeu?", a: ["Real Madrid", "Sevilla", "Barcelona", "Real Betis"], correct: 0 },
    { q: "Which country does Kylian Mbappe represent?", a: ["Belgium", "France", "Cameroon", "Portugal"], correct: 1 },
    { q: "Which German club plays at the Allianz Arena?", a: ["Borussia Dortmund", "Bayer Leverkusen", "Bayern Munich", "Schalke 04"], correct: 2 },
    { q: "What is Europe's top club competition called?", a: ["Europa League", "Champions League", "Nations League", "Super Cup"], correct: 1 }
  ]},
  { name: "Medium", cls: "medium", questions: [
    { q: "Which club did Neymar leave to join PSG in his 2017 world-record move?", a: ["Santos", "Real Madrid", "Barcelona", "Bayern Munich"], correct: 2 },
    { q: "Cristiano Ronaldo moved from Manchester United to which club in 2009?", a: ["Juventus", "Real Madrid", "Barcelona", "Sporting CP"], correct: 1 },
    { q: "Which club went the whole 2003-04 Premier League season unbeaten?", a: ["Chelsea", "Manchester United", "Arsenal", "Liverpool"], correct: 2 },
    { q: "Which nation won the delayed Euro 2020 tournament, played in 2021?", a: ["England", "Spain", "Italy", "Portugal"], correct: 2 },
    { q: "In which season did Leicester City win the Premier League?", a: ["2013-14", "2014-15", "2015-16", "2016-17"], correct: 2 },
    { q: "Which nation won the 2010 FIFA World Cup?", a: ["Netherlands", "Spain", "Germany", "Brazil"], correct: 1 },
    { q: "Which country hosted the 2018 FIFA World Cup?", a: ["Qatar", "Brazil", "Russia", "Germany"], correct: 2 },
    { q: "Which club did Lionel Messi join after leaving Barcelona in 2021?", a: ["Inter Miami", "Paris Saint-Germain", "Manchester City", "Al-Hilal"], correct: 1 },
    { q: "Who managed Manchester United from 1986 to 2013?", a: ["Arsene Wenger", "Matt Busby", "Alex Ferguson", "David Moyes"], correct: 2 },
    { q: "Which nation won Euro 2016?", a: ["France", "Portugal", "Germany", "Wales"], correct: 1 },
    { q: "Which nation won the 2014 FIFA World Cup?", a: ["Argentina", "Netherlands", "Brazil", "Germany"], correct: 3 },
    { q: "Which club is nicknamed 'the Old Lady'?", a: ["AC Milan", "Juventus", "Roma", "Inter Milan"], correct: 1 },
    { q: "Zinedine Zidane was sent off in the 2006 World Cup final for headbutting which player?", a: ["Fabio Cannavaro", "Gennaro Gattuso", "Marco Materazzi", "Andrea Pirlo"], correct: 2 },
    { q: "Who won the 2018 Ballon d'Or, ending a decade of Messi and Ronaldo wins?", a: ["Luka Modric", "Antoine Griezmann", "Mohamed Salah", "Kevin De Bruyne"], correct: 0 },
    { q: "Erling Haaland joined Manchester City in 2022 from which club?", a: ["RB Salzburg", "Borussia Dortmund", "Molde", "RB Leipzig"], correct: 1 },
    { q: "Which nation won Euro 2024?", a: ["England", "France", "Spain", "Germany"], correct: 2 }
  ]},
  { name: "Hard", cls: "hard", questions: [
    { q: "Who is the all-time top scorer in Champions League history?", a: ["Lionel Messi", "Robert Lewandowski", "Cristiano Ronaldo", "Karim Benzema"], correct: 2 },
    { q: "Which manager has won the most Champions League titles?", a: ["Pep Guardiola", "Carlo Ancelotti", "Alex Ferguson", "Bob Paisley"], correct: 1 },
    { q: "Who scored a record 13 goals at a single World Cup, in 1958?", a: ["Just Fontaine", "Gerd Muller", "Pele", "Ronaldo Nazario"], correct: 0 },
    { q: "How many goals did Cristiano Ronaldo score in the 2013-14 Champions League, a single-season record?", a: ["14", "15", "17", "19"], correct: 2 },
    { q: "Who is the all-time top scorer at men's World Cup finals tournaments?", a: ["Ronaldo Nazario", "Miroslav Klose", "Gerd Muller", "Lionel Messi"], correct: 1 },
    { q: "Which club won the first European Cup, in 1956?", a: ["Benfica", "AC Milan", "Real Madrid", "Reims"], correct: 2 },
    { q: "Diego Maradona's 'Hand of God' goal in 1986 came against which nation?", a: ["Italy", "England", "West Germany", "Belgium"], correct: 1 },
    { q: "Which nation won the first FIFA World Cup, in 1930?", a: ["Argentina", "Italy", "Brazil", "Uruguay"], correct: 3 },
    { q: "Who holds the record for most Premier League goals?", a: ["Wayne Rooney", "Harry Kane", "Alan Shearer", "Thierry Henry"], correct: 2 },
    { q: "Who is the only goalkeeper to have won the Ballon d'Or?", a: ["Gianluigi Buffon", "Lev Yashin", "Manuel Neuer", "Oliver Kahn"], correct: 1 },
    { q: "How many goals did Lionel Messi score in the 2012 calendar year?", a: ["73", "86", "91", "96"], correct: 2 },
    { q: "Who scored the fastest hat-trick in Premier League history, in 2015?", a: ["Robbie Fowler", "Sadio Mane", "Sergio Aguero", "Jermain Defoe"], correct: 1 },
    { q: "Who won the first Ballon d'Or, in 1956?", a: ["Alfredo Di Stefano", "Stanley Matthews", "Ferenc Puskas", "Raymond Kopa"], correct: 1 },
    { q: "Which nation shocked Europe by winning Euro 2004?", a: ["Denmark", "Czech Republic", "Greece", "Portugal"], correct: 2 },
    { q: "Which nation beat Brazil in the deciding 1950 World Cup match known as the 'Maracanazo'?", a: ["Uruguay", "Sweden", "Spain", "Argentina"], correct: 0 },
    { q: "Which club came back from 3-0 down at half-time to win the 2005 Champions League final?", a: ["AC Milan", "Liverpool", "Chelsea", "Porto"], correct: 1 }
  ]}
];

// Stable ids so we can avoid repeats across matches (e.g. "medium-4")
TIERS.forEach(tier => tier.questions.forEach((item, i) => { item.id = `${tier.cls}-${i}`; }));

module.exports = { TIERS };
