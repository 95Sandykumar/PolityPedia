# Pick the voice (X5, ticket H4)

Boss, this is the whole job. About 20 minutes, most of it waiting for two
sign-ups. Nothing you do here changes what students see. The app only starts
using a voice at step 6.

Run every command from inside `web/`.

---

## Step 1. Make the ElevenLabs key

1. Open <https://elevenlabs.io> and sign up.
2. Open your profile menu, then **API Keys**, then **Create API Key**.
3. Copy the key. It starts with `sk_`. You see it once.
4. Open **Voices** in the left menu, then the **Voice Library**.
5. Pick one voice that reads English and one that reads Hindi. On a voice card,
   use the three dots, then **Copy voice ID**. You need two ids.
   A voice ID looks like `JBFqnCBsd6RMkjVDRZzb`.

If you want one voice for both languages, paste the same id twice. The model
is multilingual, so that works; two voices usually sound better.

## Step 2. Make the Google key

1. Open <https://console.cloud.google.com> and sign in.
2. Make a project, or pick one you have.
3. Open **APIs and Services**, then **Library**, search for
   **Cloud Text-to-Speech API**, and press **Enable**.
4. Open **APIs and Services**, then **Credentials**, then
   **Create credentials**, then **API key**.
5. Copy the key. Press **Edit API key** and under **API restrictions** choose
   **Restrict key** and tick **Cloud Text-to-Speech API** only. That way a
   stolen key can only make audio.

Google needs a billing account on the project. There is a free monthly
allowance, and these four samples are a few hundred characters, so this test
costs about nothing.

## Step 3. Put the keys in `web/.env.local`

Open `web/.env.local` (make it if it is not there) and add these lines. Replace
the fake values with yours. This file is gitignored, so nothing is pushed.

```
ELEVENLABS_API_KEY=sk_your_key_here
ELEVENLABS_VOICE_EN=your_english_voice_id
ELEVENLABS_VOICE_HI=your_hindi_voice_id

GOOGLE_TTS_API_KEY=your_google_key_here
```

Do **not** add `VOICE_PROVIDER` yet. That is step 6.

Optional, only if you want to try something else later:

| Variable | What it changes | Default |
|---|---|---|
| `ELEVENLABS_MODEL` | the ElevenLabs model | `eleven_multilingual_v2` |
| `GOOGLE_TTS_VOICE_EN` | the Indian English voice | `en-IN-Neural2-A` |
| `GOOGLE_TTS_VOICE_HI` | the Hindi voice | `hi-IN-Neural2-A` |

`eleven_flash_v2_5` is the cheaper ElevenLabs model and also speaks Hindi. Try
it if the price matters more than the polish.

## Step 4. Make the samples

```
node --import ./jobs/register-alias.mjs jobs/voice-samples.ts
```

You get four mp3 files in `web/live-checks/voice-samples/`:

```
elevenlabs-en.mp3
elevenlabs-hi.mp3
google-en.mp3
google-hi.mp3
```

The job prints, for each file, the characters it sent, a rough price, and the
path. **Every price it prints is UNVERIFIED.** It comes from a guess table in
`jobs/voice-prices.ts`. Open the two pricing pages it names and check the real
numbers before you decide on cost.

If you only set up one provider, it makes two files and says which variables
the other one still needs. If you set up neither, it just tells you what to add
and stops. Nothing breaks either way.

Want your own words instead of the built-in explanation?

```
node --import ./jobs/register-alias.mjs jobs/voice-samples.ts --text-en="your English text" --text-hi="आपका हिंदी वाक्य"
```

## Step 5. Listen

Play all four. Judge these four things:

1. Does the Hindi sound like a teacher, or like a machine spelling it out?
2. Are `अनुच्छेद`, `सेवानिवृत्त` and `प्रतिनिधित्व` said right?
3. In English, are "Rajya Sabha" and "Lok Sabha" said right?
4. Is the speed calm enough to follow at 1.25x? Students get a speed button.

The Hindi file is the one that decides it. Most providers do English well.

## Step 6. Set the winner

Add ONE of these lines to `web/.env.local`:

```
VOICE_PROVIDER=elevenlabs
```

or

```
VOICE_PROVIDER=google
```

Then add the same variable, and the winner's key and voice ids, to the Vercel
project environment (Settings, then Environment Variables) and redeploy.

That is the moment audio turns on. From then on, each explanation is read out
once, saved, and every student plays the same file.

To turn it off again, delete the `VOICE_PROVIDER` line. Any other value, or no
value, means no audio and no error.

## If something goes wrong

| What you see | What it means |
|---|---|
| `voice provider not set up` | a key or a voice id is missing from `web/.env.local` |
| `voice call failed with status 401` | the key is wrong, or ElevenLabs has not accepted it |
| `voice call failed with status 403` | the Google key is restricted to the wrong API, or billing is off |
| `voice call failed with status 429` | out of credit, or too many calls too fast |
| `text is longer than the API allows` | the sample text is too long for that provider |

The job never prints your key and never prints the provider's reply, so an
error line is safe to paste anywhere.
