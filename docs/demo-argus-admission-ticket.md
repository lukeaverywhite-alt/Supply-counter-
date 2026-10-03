# Demo: admission by invitation ticket

This is the demo for the "admission by invitation ticket" epic (design: [ADR 012](adr/012-admission-by-invitation-ticket.md)).
People now join a unit with a **ticket**: a one-use ticket for one named person, with a role chosen for them, that runs out
after a week. It is shown as a QR picture and a short code (35 characters, in groups of five). The new person's own phone
redeems it from the BSV testnet chain, **with the Master's phone closed**. The old oversized admission QR and the long paste
code are gone.

Run it on the live site, **https://jonathan-a-white.github.io/argus/**, after CI has deployed. Everything is BSV testnet:
the coins are free and worth nothing.

## What you need

- **Phone A**: the Master's phone. You will make a new unit on it in step 1.
- **Phone B**: a second phone that has **never** opened A.R.G.U.S. (or whose browser storage is cleared).
- **Browser C**: a third place to type a code that is already used or cancelled. A private or incognito tab on either
  phone works, because a private tab keeps its own separate storage and behaves like a new device.
- A way to send text between phones (a message to yourself is fine), or to point Phone B's camera at Phone A's screen.
- About 10 minutes. Steps 2 to 6 need network on every phone.

## 1. Make the unit (Phone A)

Open the site on Phone A.

**Expect:** a screen titled **Set up this device**, with the banner "BSV TESTNET", and exactly three choices: **I have a
ticket**, **Create a new unit** and **Restore Master from a recovery file**. There is no "Join a unit" button and no join
code anywhere.

Tap **Create a new unit**. Fill **UNIT NAME** (for example `Demo Unit`), **YOUR NAME OR CALL SIGN** (for example `Master`) and
a **PASSPHRASE** of at least 12 characters with a letter and a number (for example `supply closet 42`), twice. Tap **Create
unit**.

**Expect:** the app opens on the main screen. This phone is the unit's Master.

## 2. Give the Master's wallet testnet coins (Phone A)

A ticket carries a small amount of testnet coins for the new person (2,000 satoshis), so the Master's wallet must hold some
before it can make one. A brand-new wallet is empty.

Tap the **More** tab, then the **Wallet & sync** tile.

**Expect:** a panel titled **Wallet & sync** with the notice "BSV TESTNET ONLY", **THIS DEVICE'S TESTNET ADDRESS**, and
**SPENDABLE** showing `0 satoshis` (the status may also show a red banner starting "This device needs testnet coins …" once
something is waiting to publish).

Tap **Copy address**, then tap **Get testnet coins**. This opens the testnet faucet
(https://witnessonchain.com/faucet/tbsv). Paste the address, ask for coins, then come back and tap **Refresh balance**.

**Expect:** after a minute or so, **SPENDABLE** is at least 10,000 satoshis (it can show under **CONFIRMED · UNCONFIRMED**
first). The whole demo spends about 6,000 of them on tickets, plus a 2,500 top-up for the Instructor in step 7. If the faucet is down or limits you, try again later. Without coins, step 3 refuses with "This device's testnet wallet
… has 0 spendable satoshis but needs about …. Send testnet coins to … from a BSV testnet faucet, then try again."

Close the panel.

## 3. Make a ticket (Phone A)

Tap **More**, then the **Tickets** tile ("Make a ticket for a new person, see tickets out, cancel one").

**Expect:** a panel titled **Tickets** with a **Make a ticket** form (**NAME**, **ROLE**), and below it **Tickets out** saying
"No tickets are out."

In **NAME** type `Cadet One`. Leave **ROLE** as **Supply Assistant**. (As Master, the role list also offers Supply Officer and
Instructor.) Tap **Make ticket**.

**Expect:** a box headed **Ticket ready for Cadet One**, with "Supply Assistant · good for one use until" a date a week away,
a **QR picture** (alt text "Ticket QR code for Cadet One"), the **code** in six groups of five separated by dashes (like
`4K7QD-Z2M9X-0B8RT-WC5HN-1EY6P-G3VJA`), and the buttons **Copy code**, **Share** (where the phone offers it) and **Hide**.
Under **Tickets out** there is now one entry: **Cadet One · Supply Assistant · 7 days left**, with a **Cancel** button.

Send the code to Phone B (**Copy code**, then paste it into a message), or leave the QR on screen for Phone B's camera.
**Write the code down** for step 5.

## 4. Join on Phone B with the Master's phone closed

**Close Phone A's browser tab completely** (or lock the phone and turn its screen off). It stays closed until step 6.

On Phone B, open the site.

**Expect:** the same **Set up this device** screen with its three choices.

Tap **I have a ticket**. Either type or paste the code into **TICKET CODE** (capitals, spaces and dashes do not matter, so a
code a messenger has re-wrapped still works), or use **OR A PICTURE OF ITS QR** to take a photo of Phone A's QR (or choose a
screenshot of it). Tap **Check ticket**.

**Expect:** a box headed **Ticket for Cadet One**, reading "Supply Assistant · Demo Unit · made by Master. Good until" the
date, and two new fields **PASSPHRASE** and **CONFIRM PASSPHRASE**. The button now reads **Join unit**. (If it says "This
ticket is not on the network yet", wait a minute and tap again.)

Choose a passphrase (for example `cadet one 2026`) twice and tap **Join unit**.

**Expect:** after a short pause the app opens on its main screen, on its own, with Phone A still closed. Phone B did not need
any coins of its own: the ticket paid for the joining.

Tap **More**, then **Members & access**.

**Expect:** the list shows **Cadet One (you) · Supply Assistant** and **Master · Master**. The **Tickets** tile is **not**
shown on Phone B, because a Supply Assistant cannot make tickets. (If the Master is not listed yet, go back and tap **Wallet &
sync**, then **Sync now**.)

## 5. The same code a second time is refused (Browser C)

Open the site in Browser C (a private tab, so it is a fresh device). Tap **I have a ticket**, type the **same code** from step 3
and tap **Check ticket**.

**Expect:** a red message, **This ticket was already used on another device.** No passphrase fields appear, and nothing is
created on Browser C.

## 6. Cancel a ticket (Phone A, then Browser C)

Reopen the site on Phone A and unlock it with the Master's passphrase. Open **More**, then **Tickets**.

**Expect:** **Tickets out** is empty ("No tickets are out."). A line **Used, cancelled or expired (1)** is folded below; open it
and see **Cadet One · Supply Assistant · Used**.

Make another ticket: **NAME** `Cadet Two`, **ROLE** **Supply Officer**, **Make ticket**. Write down the new code.

**Expect:** **Ticket ready for Cadet Two**, and under **Tickets out**: **Cadet Two · Supply Officer · 7 days left**.

Tap **Cancel** on the Cadet Two entry (its label for a screen reader is "Cancel ticket for Cadet Two").

**Expect:** a message "The ticket for Cadet Two was cancelled." The entry leaves **Tickets out**, and **Used, cancelled or
expired (2)** now lists **Cadet Two · Supply Officer · Cancelled**. If there was no connection, the message instead says the
cancellation "is saved and goes out when the network is reachable. Tap Cancel again then to finish it."

In Browser C, tap **I have a ticket**, type the Cadet Two code and tap **Check ticket**.

**Expect:** a red message, **This ticket was cancelled.** Nothing is created on Browser C.

## 7. An Instructor can only make cadet tickets

On Phone A, in **Tickets**, make a ticket: **NAME** `Instructor One`, **ROLE** **Instructor**, **Make ticket**. Write down the
code.

**Expect:** **Ticket ready for Instructor One**.

In Browser C, tap **I have a ticket**, type the Instructor code, tap **Check ticket**, and see "Instructor · Demo Unit · made by
Master". Choose a passphrase twice and tap **Join unit**.

**Expect:** Browser C opens on its main screen as Instructor One.

On Browser C, tap **More**, then **Tickets**.

**Expect:** the **Tickets** panel opens, with a **ROLE** list that offers **only Supply Assistant and Supply Officer** (no
Instructor, no Master), and the note "An Instructor can make tickets for Supply Officers and Supply Assistants. A Master makes
the others." Make a ticket for `Cadet Three` as a Supply Assistant to see it works.

A ticket is paid for by whoever makes it, and Instructor One's wallet holds only the small change left from joining. If
**Make ticket** refuses with "… has … spendable satoshis but needs about …", that is the funding rule working: on Phone A open
**More**, **Wallet & sync**, and under **Top up a member** paste Instructor One's address (on Browser C, **Wallet & sync**, **Copy
address**), set **SATOSHIS** to `2500` and tap **Send**; once Browser C's **Wallet & sync** shows the coins under **SPENDABLE**
(**Refresh balance**), tap **Make ticket** again.

**Expect:** **Ticket ready for Cadet Three**, and the entry appears under **Tickets out** with a **Cancel** button. On Phone A (after **Sync now**), the same entry shows under **Tickets
out** with "Made by Instructor One" and **no** Cancel button, because only the person who made a ticket can cancel it.

Phone B (the Supply Assistant) never had a **Tickets** tile, so an ordinary cadet cannot make tickets at all.

## 8. The old admission screens are gone

On any phone with the unit open, tap **More** and **Members & access**.

**Expect:** a list of people with roles, **Change role…** and **Remove access…** for a Master, and a note that reads "To add a
person, make them a ticket in Tickets (Command Center)." There is **no** "Admit", "Join code", "Admission code" or
admission-QR button or field anywhere. On a fresh device the **Set up this device** screen has only the three choices from
step 1.

## If something does not match

Write down the step number, what the screen said, and which phone. The technical record for each step is in the Tickets panel
(the entries and their status) and under **More**, then **Diagnostics**.
