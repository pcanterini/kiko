// Imported before Ink by a test that reads the colours drawn: chalk (under Ink) settles its colour
// depth once, as it loads, from the environment. Truecolor here, whatever runs the tests.
process.env.FORCE_COLOR = "3";
