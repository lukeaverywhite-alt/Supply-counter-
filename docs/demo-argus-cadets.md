# Demo: the Cadet role

This is the demo for the "Cadet role with real privacy" epic (design: [ADR 013](adr/013-cadet-channels.md)). Each cadet can now
have a phone of their own. It shows the cadet what they **have** and what they **still need**, and nothing else: the cadet's
phone holds the keys to that one cadet's small sealed record and no key to the unit's log, so it cannot read any other cadet,
any member or any count. Staff keep the record current from their own phones, and can send notices to every cadet or a note to
one cadet. There is no server: the record is a sealed message on the BSV testnet chain, and the cadet's phone fetches it.

Run it on the live site, <https://jonathan-a-white.github.io/argus/>, after CI has deployed. Everything is BSV testnet: the
coins are free and worth nothing.

On bold text: in this file, what is written in bold is exactly what is written on the screen (a button, a field, a heading). The
test `src/docs/demoCadets.test.ts` checks that every bold phrase still occurs in the app, so if a label here does not match
your screen, the screen was renamed since this was written: say so.

## What you need

- Phone A: the Master's phone (the supply counter). You will make a new unit on it in step 1.
- Phone B: a second phone that has **never** opened A.R.G.U.S. (or whose browser storage is cleared). It plays the cadet. A
  private or incognito tab on Phone A also works, because a private tab keeps its own separate storage and behaves like a new
  phone.
- A way to send text between phones (a message to yourself is fine), or to point Phone B's camera at Phone A's screen.
- About 20 minutes. Every step needs network on the phone you are using.

## 1. Make the unit (Phone A)

Open the site on Phone A. Tap **Create a new unit**. Fill **UNIT NAME** (for example `Demo Unit`), **YOUR NAME OR CALL SIGN**
(for example `Master`) and a **PASSPHRASE** of at least 12 characters with a letter and a number (for example `supply closet
42`), twice. Tap **Create unit**.

**Expect:** the app opens on its main screen. This phone is the unit's Master. (If you have a unit from the admission-ticket demo
you can use it instead: [demo-argus-admission-ticket.md](demo-argus-admission-ticket.md).)

## 2. Give the Master's wallet testnet coins (Phone A)

A cadet's ticket and each sealed record are paid for by the staff phone that makes them, in tiny amounts: the demo spends well
under 5,000 satoshis. A brand-new wallet is empty.

Tap the **More** tab, then the **Wallet & sync** tile. Tap **Copy address**, then **Get testnet coins**, paste the address into
the testnet faucet (https://witnessonchain.com/faucet/tbsv), ask for coins, come back and tap **Refresh balance**.

**Expect:** after a minute or so, **SPENDABLE** shows at least 10,000 satoshis. Close the panel.

## 3. Put one item on the shelf and add a cadet (Phone A)

A new unit starts with the standard catalog at zero. Tap the **Inventory** tab and open **Gold PT Shirt**. Under **Add sizes**,
pick size M and tap the add button, then tap **Receive** on the M line, type `5` in **Quantity received** and tap **Add to
stock**.

Tap the **Cadets** tab, then **Add cadet**. Leave **Cadet ID (optional)** blank (a random ID like `C-4F7K` is made), choose a
**Gender**, and type `Avery Private` in **Name (optional · encrypted)**. Tap **Add cadet**.

**Expect:** the toast says the cadet was added, and the list shows the new cadet by ID, never by name. Write down the ID.

## 4. Make the cadet's phone ticket (Phone A)

Tap the cadet to open the drawer. Find the **Phone ticket** section and tap **Make phone ticket**.

**Expect:** a box headed **Phone ticket ready for** the cadet's ID, "Good for one use until" a date a week away, a QR picture, a
code in six groups of five characters separated by dashes, and the buttons **Copy code** and **Hide**. The toast says "Phone
ticket made for" the ID. Send the code to Phone B (**Copy code**, then paste it into a message), or leave the QR on screen for
Phone B's camera.

Tap **Hide**, close the drawer and open the cadet again.

**Expect:** the drawer now says "Phone ticket made" with today's date, "by You", and a line "No phone yet" (no phone has joined
yet). There is no **Make phone ticket** button but there is a **Replace phone** button (step 10): the code is shown once, so copy it
now.

Within a few seconds of the ticket being made, Phone A also publishes the cadet's first record, without any other change.

## 5. Join on Phone B: My gear (Phone B)

Open the site on Phone B.

**Expect:** the screen **Set up this device**, with three choices.

Tap **I have a ticket**. Type or paste the code into **TICKET CODE** (capitals, spaces and dashes do not matter), or use **OR A
PICTURE OF ITS QR** to photograph Phone A's QR. Tap **Check ticket**.

**Expect:** a box headed **Cadet ticket for** Avery Private, and two new fields **PASSPHRASE** and **CONFIRM PASSPHRASE**. The
button now reads **Join unit**.

Choose a passphrase (for example `cadet one 2026`) twice and tap **Join unit**.

**Expect:** the phone opens on **My gear**: the unit name at the top with "Cadet" above it, the cadet's name with their ID, a line
"Updated" with a time, **Have** with "Nothing issued yet" and **Still needed** with "Nothing still needed". (For a moment it may
say "Reading your gear…", and if the first record is not there yet, "The supply counter has not published your gear yet": tap
**Refresh** after a few seconds.) There are no tabs and no unit screens: the only buttons are **Notices**, **Settings** and
**Refresh**. The phone needed no coins of its own; the ticket paid for joining.

Back on Phone A, open the cadet's drawer again (close it and open it, to read the line afresh).

**Expect:** the line under the ticket now says "Phone: joined" with today's date, where it said "No phone yet" before.

## 6. An issue shows up (Phone A, then Phone B)

On Phone A, open the cadet's drawer and tap **Issue Items**. Choose the **PT** bundle, then tap through to "Confirm Issue". The
PT bundle is a Gold PT Shirt, PT Shorts and a Khaki Ball Cap; only the shirt is on the shelf.

**Expect:** the review says **Partial issue**, listing the shirt as ready to issue and the rest under "Still needed after
issue". After "Confirm Issue" you see "Issue Complete".

On Phone B, wait about 10 seconds (the record is sealed and sent a couple of seconds after the issue) and tap **Refresh**.

**Expect:** under **Have**, "Gold PT Shirt" with "Size M" and "Qty 1"; under **Still needed**, the PT Shorts and the Khaki Ball
Cap, each with "Qty 1"; and "Updated" has moved on to a later time.

Phone B also looks for a newer record on its own: when the app opens, when you come back to its tab, and every 25 minutes while
it is open. Tapping **Refresh** is the way to see a change at once. The phone asks only for its own small address, so many
cadets add very little load.

## 7. A notice to all cadets (Phone A, then Phone B)

On Phone A tap **More**, then the **Notices** tile.

**Expect:** a panel **Notices** with the box **Notice to all cadets**, a **Send** button and, under **Sent notices**, "No notices
have been sent."

Type `Military ball: bring your SDBs` and tap **Send**.

**Expect:** the toast "Notice sent", the box empties, and the notice shows under **Sent notices** with "To all cadets".

On Phone B, wait a few seconds and tap **Refresh**.

**Expect:** a banner at the top of My gear, **1 new notice**, and a badge "1" on the **Notices** button. If the phone allowed
notifications, a device notification as well (titled with the unit's name). Tap the banner.

**Expect:** a screen **Notices** with the text, the label **New**, and the sender's name and the time. Tap **My gear**: the
banner and the badge are gone. Close the app, open it again and unlock it: still no banner, and the notice is listed without
**New**.

The phone cannot be notified while the app is closed. That needs a push server, which A.R.G.U.S. deliberately does not have; it
is a later-epic question (see the README's Cadet role section).

## 8. A note to one cadet (Phone A, then Phone B)

On Phone A, open the cadet's drawer and tap **Message this cadet**. Type `Come by the supply counter Thursday` into **Message to
this cadet** and tap **Send**.

**Expect:** the toast "Message sent to" the cadet's ID, and under More, Notices, **Sent notices** the entry shows "To cadet" and
the ID. (For a cadet with no phone ticket it says **This cadet has no phone yet**, and offers no way to send.)

On Phone B, tap **Refresh**.

**Expect:** the note shows under **Notices** with **New**, next to the notice from step 7. Only this cadet's phone can open it: a
second cadet's phone, given the same unit, would not see it.

## 9. What the cadet phone cannot do (Phone B)

Look around Phone B.

**Expect:** there is no Cadets, Inventory, Count, Activity or More tab, no list of other cadets, members or stock, and no way to
reach one. Tap **Settings**: it says which cadet the phone belongs to, says where device notifications stand (with **Allow
notifications** when the phone has not been asked), and offers **Close** and **Leave this unit**.

## 10. Replace the cadet's phone (Phone A, then Phone B)

Say Phone B was lost or swapped. On Phone A, open the cadet's drawer. Under the ticket line tap **Replace phone**.

**Expect:** a question, "Replace this cadet's phone? The old phone stops getting updates.", with the buttons **Yes, replace
phone** and **Keep this phone**. Tap **Keep this phone**: nothing happens and the **Replace phone** button is back. Tap **Replace
phone** again, then **Yes, replace phone**.

**Expect:** the same box as in step 4, **Phone ticket ready for** the cadet's ID, with a new QR and a new code (different from the
first), and the toast "Phone replaced for" the ID. Copy the new code. Tap **Hide**, close the drawer and open it again: the line now
says "No phone yet" again, because the new phone has not joined.

On Phone A tap **More**, then **Notices**, and send a notice to all cadets, `After the replacement`. On Phone B tap **Refresh**.

**Expect:** nothing new: no banner, no new notice, and "Updated" does not move. The old phone reads only its old, abandoned
address, and staff no longer write there. Phone B keeps showing what it had.

## 11. Leave this unit (Phone B)

Tap **Leave this unit**.

**Expect:** a warning that leaving erases this phone's copy of the ticket and keys, and the buttons **Keep my place** and **Yes,
leave this unit**. Tap **Yes, leave this unit**.

**Expect:** the phone returns to **Set up this device**. Type the same code again under **I have a ticket** and tap **Check
ticket**: it is refused, since a ticket works once. A cadet who has left needs a new ticket from the supply counter.

## 12. The new phone joins (Phone B, or a third phone)

On Phone B, now at **Set up this device** (or on a third phone that has never opened A.R.G.U.S.), tap **I have a ticket**, type the
**new** code from step 10 into **TICKET CODE** and tap **Check ticket**. Choose a passphrase twice and tap **Join unit**.

**Expect:** **My gear** opens as in step 5, with the same **Have** and **Still needed**; and **Notices** lists the notice from
step 10 (`After the replacement`) as **New**. Back on Phone A, open the cadet's drawer: the line says "Phone:
joined" with today's date. That is the whole replace: a new ticket, a new phone, and the old phone dark.

## Not on a screen yet

- Showing a made code again, and sweeping the coins of a ticket nobody used.

## If something does not match

Write down the step number, what the screen said and which phone. On Phone A the record for each step is in the **Activity**
tab and under **More**, then **Diagnostics**. On Phone B, tap **Refresh** and, if it says it could not reach the network, check
the connection: Phone B keeps showing the last record it read.
