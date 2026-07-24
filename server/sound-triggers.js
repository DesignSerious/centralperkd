// Canonical catalog of game sound "triggers" the operator can re-skin from the
// /sounds admin page. Each entry is a stable `key` (never rename — it's what
// sounds.json and sfx.js reference), a human label, a short description, and the
// `defaultFile`: the built-in sound (in client/public/audio/misc/) that plays
// when no custom sound is assigned. `defaultFile: null` means the default is a
// synthesized tone (no file to show/preview).
//
// The client sfx library (client/src/lib/sfx.js) references these SAME keys in
// its fire('<key>', …) wrappers, and its defaults use these SAME files — keep
// the three in sync. Assigning a custom sound here overrides the default.
module.exports = [
  { key: 'joinRoom',       label: 'Player joins the room',       desc: 'When a player joins and their piece pops into the room.', defaultFile: 'Entered Room.mp3' },
  { key: 'roundIntro',     label: '"Next up" round panel',       desc: 'The panel that announces the next round and category.',   defaultFile: null },
  { key: 'answerLocked',   label: 'Answer / vote locked in',     desc: 'The ding when a player submits an answer or a vote.',     defaultFile: 'Ding1.mp3' },
  { key: 'questionReveal', label: 'Question appears',            desc: 'The moment the question is shown to everyone.',           defaultFile: 'Word reveal.mp3' },
  { key: 'bluffPhase',     label: '"Somebody knows" panel',      desc: 'The bluffing panel where the players who knew it write lies.', defaultFile: null },
  { key: 'votingIntro',    label: '"Which one is true?" panel',  desc: 'The voting panel where the ballot of answers appears.',   defaultFile: null },
  { key: 'bluffCard',      label: 'A bluff card flips',          desc: 'Each bluff card as it is revealed.',                      defaultFile: 'Bluff.mp3' },
  { key: 'truthReveal',    label: 'The real answer fanfare',     desc: 'The triumphant cue when the true answer is shown.',       defaultFile: 'Trumpet.mp3' },
  { key: 'suspense',       label: 'Suspense build (loops)',      desc: 'Heartbeat that loops while the real answer builds.',      defaultFile: 'Heart Beat 1.mp3' },
  { key: 'pieceMove',      label: 'Piece slides on the board',   desc: 'Each piece sliding to its new space during scoring.',     defaultFile: 'Slide.mp3' },
  { key: 'arrowBonus',     label: 'Arrow tile — skip ahead',     desc: 'When a piece lands on an arrow and jumps forward.',        defaultFile: null },
  { key: 'coffeeBonus',    label: 'Coffee tile — double points', desc: 'When a piece lands on a coffee-cup bonus tile.',           defaultFile: null },
  { key: 'countdownTick',  label: 'Countdown tick',              desc: 'Alternating clock tick in the final seconds.',            defaultFile: 'Tick1.mp3' },
  { key: 'countdownTock',  label: 'Countdown tock',              desc: 'Alternating clock tock in the final seconds.',            defaultFile: 'Tock1.mp3' },
  { key: 'timeUp',         label: "Time's up buzzer",            desc: 'The blast when the countdown hits zero.',                 defaultFile: 'Buzzer.mp3' },
  { key: 'scoreboard',     label: 'Scoreboard appears',          desc: 'When the round scoreboard lands.',                        defaultFile: 'Scoreboard.mp3' }
];
