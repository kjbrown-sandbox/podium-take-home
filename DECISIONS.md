# Preample

I've found that the only way to record why I make my decisions is to write them out stream-of-consciousness style. Like a journal. It's a little disjointed, admittedly, but it's the truest way to get insight into why I think the way I do.

# The actual thoughts/decisions

Okay! Lots to do, not a lot of time. Here are my first thoughts.

I'm most familiar with TypeScript, so I'm going to use that. We need to move fast, so ironically, I'd like to get a test suite up first. It makes it easy to verify if I'm going in the right direction and if I ever accidentally introduce changes that break a previous feature.

Holy Hannah, Claude copied the structure from the PDF wrong. The structure was almost the same. But a careful look revealed some subtle but distinct differences. Ha! I'm happy it could read from PDFs at all.

As far as feature we'll implement, I've read through the PDF myself and agree with the list that Claude made about features in order of importance. We can go in that order.

I like starting with broken tests because then when it passes green, I know my changes did something. Nothing more misleading than a "green" test that was actually poorly written and never caught the bad logic.

Right now, I'm going through and comparing the yaml to the types that Claude just produced. (After checking.) Heck yeah! Looks great. But I think I found a typo in the yaml given to me (may or may not be intnetional).

I'm now looking at tests to see if they accurately test the implementation we haven't made yet. I'll do tests one feature at a time. (After checking.) Tests look good!

Now that config parsing is done, time for strip_prefix and timeouts. Tests first, then implementation. Let's do it. We're going to need mocks for servers, so let me check the implementation. I noticed that there was a new function `parseDuration` that was untested, so I added tests for that.

Now onto rate limiting. Most of this is straightforward, but there are 2 options for sliding window. I'm more familiar with the true sliding window, which is we keep track of every single timestamp in, say, queue, and when a new request is made, we check the oldest and see if it's within the rate limit AND if there are too many requests already. It's the most accurate version, but it requires we keep in memory each timestamp per request. Not horrible. But we'll use a weighted approximation instead since it's accurate enough, much faster and cheaper, and it's what production systems would actually use.

I'm going over the tests for rate limiting now. They're not bad, though I worry a bit about the sequential testing in the test suite considering that one failure cascades to the next. The limits are very reasonable, though, and it would be really heavy to spin up another gateway within one test bed for true independence. I'll keep them as they are. I also noticed we didn't have enough edge cases, so I added a few more. Tests are looking good now. Just need to implement it now. Adding a time injection to reduce flakiness around verifying when the window is unblocked (can be done with raw waits/timeouts, but that's flaky).

I noticed some code duplication when it implemented rate limiting, so I refactored it.

Auth isn't too bad. Tests look okay. Time to implement. It's a very simple auth thing, obviously nothing connected to OAuth or anything, but it'll do for this take home.

Tests for retrying look solid too. Moving forward with implementation. We're storing the entire response now in our buffer instead of immediately piping it to the server because we need to store a copy if we want to retry it.

Time for circtuit breaking now, ooooh. I've looked through the tests, they feel fine to me. Slightly redundant on checking that things work without the circuit breaking specs (it's the standard stuff already tested), but I believe in redundancy for tests when they're cheap. And these ones are. Onwards to implementation!
