/**
 * Demo question bank: 20 MCQs on Indian polity and political theory for
 * UGC NET / CUET PG Political Science. First 10 go in the FREE sample test,
 * the last 10 in the paid test. `correct` is the 0-based index into `options`.
 * `hi` (Devanagari) is appended to the teacher explanation for 4 questions,
 * because `questions.teacher_explanation` is one text column.
 */
const QUESTIONS = [
  // ---- Test 1 (free sample) ----
  {
    stem: 'Which Article of the Constitution of India makes free and compulsory education a Fundamental Right for children aged 6 to 14 years?',
    options: ['Article 45', 'Article 21A', 'Article 51A(k)', 'Article 24'],
    correct: 1,
    expl: 'Article 21A, inserted by the 86th Amendment Act (2002), makes free and compulsory education a Fundamental Right for children aged 6 to 14. Article 45 now covers early childhood care for children below six, and Article 51A(k) is a Fundamental Duty of parents and guardians.',
    hi: 'अनुच्छेद 21A (86वां संशोधन, 2002) 6 से 14 वर्ष के बच्चों को निःशुल्क और अनिवार्य शिक्षा का मौलिक अधिकार देता है। अनुच्छेद 45 अब केवल 6 वर्ष से कम आयु के बच्चों की प्रारंभिक देखभाल से जुड़ा नीति निदेशक तत्व है।',
  },
  {
    stem: 'The doctrine of the "basic structure" of the Constitution was propounded by the Supreme Court in which case?',
    options: [
      'Golaknath v. State of Punjab (1967)',
      'Minerva Mills v. Union of India (1980)',
      'Maneka Gandhi v. Union of India (1978)',
      'Kesavananda Bharati v. State of Kerala (1973)',
    ],
    correct: 3,
    expl: 'In Kesavananda Bharati v. State of Kerala (1973) a 13-judge bench held, by 7:6, that Parliament can amend any part of the Constitution but cannot destroy its basic structure. Golaknath (1967) had said Fundamental Rights cannot be amended at all, and Kesavananda overruled it.',
    hi: 'केशवानंद भारती बनाम केरल राज्य (1973) में सर्वोच्च न्यायालय की 13 न्यायाधीशों की पीठ ने 7:6 के बहुमत से मूल ढांचा सिद्धांत दिया: संसद संविधान में संशोधन कर सकती है, पर उसके मूल ढांचे को नष्ट नहीं कर सकती।',
  },
  {
    stem: 'The power of Parliament to amend the Constitution, and the procedure for it, is laid down in which Article?',
    options: ['Article 352', 'Article 356', 'Article 368', 'Article 370'],
    correct: 2,
    expl: 'Article 368 (Part XX) gives Parliament its constituent power and lays down the amendment procedure. Article 352 deals with national emergency and Article 356 with President\'s Rule in a State.',
  },
  {
    stem: 'What is the maximum strength of the Rajya Sabha prescribed by the Constitution of India?',
    options: ['245', '238', '252', '250'],
    correct: 3,
    expl: 'Article 80 fixes the maximum strength of the Rajya Sabha at 250: up to 238 representatives of States and Union Territories plus 12 members nominated by the President. The present actual strength is 245, which is below this ceiling.',
  },
  {
    stem: 'The idea of the "veil of ignorance" in political philosophy is associated with:',
    options: ['Robert Nozick', 'John Rawls', 'Michael Sandel', 'Amartya Sen'],
    correct: 1,
    expl: 'Rawls\'s veil of ignorance (A Theory of Justice, 1971) hides people\'s class, talents and beliefs in the "original position", so that they choose fair principles of justice. Nozick\'s rival libertarian view is in Anarchy, State, and Utopia (1974).',
    hi: 'जॉन रॉल्स की "ए थ्योरी ऑफ जस्टिस" (1971) में "अज्ञान का पर्दा" मूल स्थिति (original position) का वह उपकरण है, जिसमें व्यक्ति अपनी सामाजिक स्थिति जाने बिना न्याय के सिद्धांत चुनते हैं।',
  },
  {
    stem: 'The concept of "cultural hegemony" is most closely associated with:',
    options: ['Antonio Gramsci', 'Louis Althusser', 'Georg Lukacs', 'Karl Kautsky'],
    correct: 0,
    expl: 'In his Prison Notebooks Gramsci used hegemony to explain how the ruling class rules by consent, through culture and civil society, and not only by force. It is a standard topic in Marxist political theory.',
  },
  {
    stem: 'Under the Indian Constitution, residuary powers of legislation (matters not listed in any of the three Lists) are vested in:',
    options: ['State Legislatures', 'The Inter-State Council', 'Parliament', 'The Supreme Court'],
    correct: 2,
    expl: 'Under Article 248 and Entry 97 of the Union List, Parliament alone can legislate on any matter not mentioned in the State or Concurrent Lists. India differs from the USA here, where residuary powers lie with the States.',
  },
  {
    stem: 'The structural-functional approach in comparative politics, set out in "The Politics of Developing Areas" (1960), is chiefly associated with:',
    options: ['David Easton', 'Gabriel Almond', 'Robert Dahl', 'Karl Deutsch'],
    correct: 1,
    expl: 'Gabriel Almond (with James Coleman) used the structural-functional approach, asking which structures perform which functions in every political system. David Easton is known for the systems approach (inputs, outputs, feedback).',
  },
  {
    stem: 'Which Article did Dr B. R. Ambedkar describe as "the very soul of the Constitution and the very heart of it"?',
    options: ['Article 14', 'Article 19', 'Article 32', 'Article 226'],
    correct: 2,
    expl: 'Dr Ambedkar called Article 32 (Right to Constitutional Remedies) the soul and heart of the Constitution. It lets a person go straight to the Supreme Court to enforce a Fundamental Right; Article 226 gives High Courts a wider writ power.',
    hi: 'डॉ. बी.आर. अम्बेडकर ने अनुच्छेद 32 (संवैधानिक उपचारों का अधिकार) को संविधान की "आत्मा और हृदय" कहा। इसके अंतर्गत सर्वोच्च न्यायालय मौलिक अधिकारों के प्रवर्तन के लिए रिट जारी कर सकता है।',
  },
  {
    stem: 'A "Money Bill" is defined in which Article of the Constitution of India?',
    options: ['Article 109', 'Article 110', 'Article 111', 'Article 112'],
    correct: 1,
    expl: 'Article 110 defines a Money Bill (taxation, borrowing, the Consolidated Fund and similar matters). It can be introduced only in the Lok Sabha, and the Rajya Sabha can only make recommendations. Article 112 is the annual financial statement (the Budget).',
  },

  // ---- Test 2 (paid) ----
  {
    stem: 'Judicial review of a Presidential Proclamation under Article 356 was strengthened by the Supreme Court in:',
    options: [
      'S. R. Bommai v. Union of India (1994)',
      'Shankari Prasad v. Union of India (1951)',
      'In re Berubari Union (1960)',
      'Indira Gandhi v. Raj Narain (1975)',
    ],
    correct: 0,
    expl: 'In S. R. Bommai v. Union of India (1994) a nine-judge bench held that a proclamation under Article 356 is subject to judicial review, and that secularism is part of the basic structure. The majority of a State government must be tested on the floor of the House.',
  },
  {
    stem: 'The Directive Principles of State Policy are contained in which Part of the Indian Constitution?',
    options: ['Part III', 'Part IV-A', 'Part V', 'Part IV'],
    correct: 3,
    expl: 'Articles 36 to 51 in Part IV are the Directive Principles of State Policy. Part III has the Fundamental Rights, Part IV-A has the Fundamental Duties (Article 51A) and Part V deals with the Union.',
  },
  {
    stem: 'The Tenth Schedule (the anti-defection law) was added to the Constitution by which Amendment?',
    options: [
      '42nd Amendment Act, 1976',
      '44th Amendment Act, 1978',
      '52nd Amendment Act, 1985',
      '73rd Amendment Act, 1992',
    ],
    correct: 2,
    expl: 'The Tenth Schedule was added by the 52nd Amendment Act, 1985. The 91st Amendment (2003) later removed the protection for one-third "splits" and limited the size of the Council of Ministers.',
  },
  {
    stem: 'The Eleventh Schedule, listing 29 subjects for Panchayats, was added by:',
    options: [
      '74th Amendment Act, 1992',
      '73rd Amendment Act, 1992',
      '61st Amendment Act, 1988',
      '86th Amendment Act, 2002',
    ],
    correct: 1,
    expl: 'The 73rd Amendment Act (1992) added Part IX and the Eleventh Schedule for Panchayats. The 74th Amendment added Part IX-A and the Twelfth Schedule (18 subjects) for municipalities.',
  },
  {
    stem: 'The distinction between "negative" and "positive" liberty was famously made by:',
    options: ['J. S. Mill', 'T. H. Green', 'Isaiah Berlin', 'Harold Laski'],
    correct: 2,
    expl: 'Isaiah Berlin\'s 1958 lecture "Two Concepts of Liberty" separated negative liberty (freedom from interference) from positive liberty (freedom to be one\'s own master). Mill is the classic defender of negative liberty.',
  },
  {
    stem: 'Who described life in the state of nature as "solitary, poor, nasty, brutish, and short"?',
    options: ['John Locke', 'Thomas Hobbes', 'Jean-Jacques Rousseau', 'Montesquieu'],
    correct: 1,
    expl: 'Thomas Hobbes, in Leviathan (1651), described the state of nature in these words, which is why people accept an absolute sovereign. Locke\'s state of nature is far milder, and Rousseau\'s is one of natural goodness.',
  },
  {
    stem: 'The idea of Directive Principles of State Policy in the Indian Constitution was borrowed from the Constitution of:',
    options: ['United States', 'Canada', 'Australia', 'Ireland'],
    correct: 3,
    expl: 'India borrowed the idea of Directive Principles from the Irish Constitution. Fundamental Rights and judicial review draw on the USA.',
  },
  {
    stem: 'Superintendence, direction and control of elections to Parliament and State Legislatures is vested in the Election Commission by which Article?',
    options: ['Article 324', 'Article 326', 'Article 329', 'Article 280'],
    correct: 0,
    expl: 'Article 324 vests the superintendence, direction and control of elections, including those to the offices of President and Vice-President, in the Election Commission. Article 326 provides adult suffrage and Article 329 bars courts from interfering in electoral matters.',
  },
  {
    stem: 'Who presides over a joint sitting of the two Houses of Parliament called under Article 108?',
    options: ['Chairman of the Rajya Sabha', 'President of India', 'Speaker of the Lok Sabha', 'Prime Minister'],
    correct: 2,
    expl: 'Under Article 108 the President may summon a joint sitting to resolve a deadlock over an ordinary bill, and the Speaker of the Lok Sabha presides. Money Bills and Constitution Amendment Bills are outside this procedure.',
  },
  {
    stem: 'Max Weber\'s three pure types of legitimate authority are traditional, charismatic and:',
    options: ['Legal-rational', 'Hegemonic', 'Coercive', 'Consensual'],
    correct: 0,
    expl: 'Max Weber\'s three pure types of legitimate authority are traditional, charismatic and legal-rational. Modern bureaucratic states rest mainly on legal-rational authority.',
  },
];

/** Two ready AI explanations (no audio) for the revision screen. Index into QUESTIONS. */
const AI_EXPLANATIONS = [
  {
    q: 1, // Kesavananda Bharati
    body: {
      exam: 'UGC NET Political Science',
      topic: 'Basic structure doctrine',
      question: 'Which case gave the basic structure doctrine?',
      sections: [
        {
          heading: 'The short answer',
          body: 'Kesavananda Bharati v. State of Kerala (1973). A 13-judge bench held, by 7:6, that Parliament may amend the Constitution but may not alter its basic structure.',
        },
        {
          heading: 'Why the other options are wrong',
          body: 'Golaknath (1967) held that Parliament could not amend Fundamental Rights at all, and it was overruled. Minerva Mills (1980) applied and strengthened the doctrine. Maneka Gandhi (1978) widened Article 21.',
        },
        {
          heading: 'How it is asked',
          body: 'Exams pair the case name with the year, or ask which case overruled Golaknath. Remember the order: Shankari Prasad, Sajjan Singh, Golaknath, Kesavananda.',
        },
      ],
      remember: 'Kesavananda 1973: amend yes, destroy the basic structure no.',
    },
    sources: [
      { title: 'Kesavananda Bharati v. State of Kerala (overview)', url: 'https://en.wikipedia.org/wiki/Kesavananda_Bharati_v._State_of_Kerala' },
    ],
  },
  {
    q: 4, // Rawls veil of ignorance
    body: {
      exam: 'UGC NET Political Science',
      topic: 'Rawls and justice as fairness',
      question: 'Who proposed the veil of ignorance?',
      sections: [
        {
          heading: 'The short answer',
          body: 'John Rawls, in A Theory of Justice (1971). Behind the veil, people choosing principles of justice do not know their class, talents, gender or beliefs.',
        },
        {
          heading: 'What they would choose',
          body: 'Rawls argues they would pick two principles: equal basic liberties for all, and social and economic inequalities only if they are open to all and benefit the least advantaged (the difference principle).',
        },
        {
          heading: 'Common traps',
          body: 'Nozick answers Rawls from a libertarian side (entitlement theory). Sandel criticises the "unencumbered self" from a communitarian side.',
        },
      ],
      remember: 'Rawls: veil of ignorance, original position, difference principle.',
    },
    sources: [
      { title: 'John Rawls (Stanford Encyclopedia of Philosophy)', url: 'https://plato.stanford.edu/entries/rawls/' },
    ],
  },
];

module.exports = { QUESTIONS, AI_EXPLANATIONS };
