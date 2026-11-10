# BoxPilot (M38): make, or repair, the agents' bot and channels in this Zulip.
#
# Run by the agents.zulip.connect operation as `manage.py shell --command` inside the Zulip
# container, as the zulip user. Zulip has no command that makes a bot, so this uses the same
# actions Zulip's own "Add a bot" uses (do_create_user, notify_created_bot), with the
# organization's owner as the bot's owner and as the acting user, so Zulip's audit log says the
# owner made it. Running it again changes nothing that is already right: an existing bot is
# reused (and reactivated if it was deactivated), an existing channel is kept as it is, and
# subscriptions that exist are left alone.
#
# What already exists is only reused when it is the owner's. Any member of the organization can
# make a bot or a channel, so one made first under these names is not taken on trust:
#   - a bot at the address that the owner does not own is refused (its maker would keep its key);
#   - a reused bot gets a new API key every time, so a key anyone held before stops working;
#   - a channel the owner did not make is refused while anyone but the owner and the bot is in it.
# Every refusal is decided before anything is changed, so a refused connect leaves Zulip, and the
# key BoxPilot already holds, as they were.
#
# Everything it is given comes from the environment, set by BoxPilot, never from a person:
#   BOXPILOT_BOT_SHORT_NAME  the bot's short name (its address is <short name>-bot@<bot domain>)
#   BOXPILOT_BOT_FULL_NAME   the bot's name as people see it
#   BOXPILOT_CHANNELS        JSON: [{"name": ..., "description": ...}, ...]
# It prints one line, BOXPILOT_ZULIP_RESULT followed by JSON. The bot's API key is in it; the
# operation stores it in BoxPilot's credential store and never shows or logs it.
import json
import os

from django.conf import settings

from zerver.actions.create_user import do_create_user, do_reactivate_user, notify_created_bot
from zerver.actions.streams import bulk_add_subscriptions
from zerver.lib.streams import create_stream_if_needed
from zerver.lib.users import validate_short_name_and_construct_bot_email
from zerver.models import Realm, Stream, Subscription, UserProfile
from zerver.models.users import get_user_by_delivery_email

# Zulip's own "Generate new API key": where it lives has moved between releases.
try:
    from zerver.actions.user_settings import do_regenerate_api_key
except ImportError:
    try:
        from zerver.actions.bots import do_regenerate_api_key
    except ImportError:
        try:
            from zerver.lib.actions import do_regenerate_api_key
        except ImportError:
            do_regenerate_api_key = None


def boxpilot_result(**fields):
    print("BOXPILOT_ZULIP_RESULT " + json.dumps(fields), flush=True)


def boxpilot_connect():
    short_name = os.environ["BOXPILOT_BOT_SHORT_NAME"]
    full_name = os.environ["BOXPILOT_BOT_FULL_NAME"]
    channels = json.loads(os.environ["BOXPILOT_CHANNELS"])

    realms = [
        realm
        for realm in Realm.objects.filter(deactivated=False).order_by("id")
        if realm.string_id != settings.SYSTEM_BOT_REALM
    ]
    if not realms:
        boxpilot_result(error="no-organization")
        return
    # The organization on this server's own address first: the one Serve's certificate covers.
    realm = next((candidate for candidate in realms if candidate.string_id == ""), realms[0])
    owner = (
        UserProfile.objects.filter(realm=realm, role=UserProfile.ROLE_REALM_OWNER, is_active=True, is_bot=False)
        .order_by("id")
        .first()
    )
    if owner is None:
        boxpilot_result(error="no-owner", realm=realm.name)
        return

    _short, email = validate_short_name_and_construct_bot_email(short_name, realm)
    try:
        bot = get_user_by_delivery_email(email, realm)
    except UserProfile.DoesNotExist:
        bot = None
    if bot is not None:
        if not bot.is_bot:
            boxpilot_result(error="address-taken", realm=realm.name, bot=email)
            return
        if bot.bot_owner_id != owner.id:
            boxpilot_result(error="bot-not-yours", realm=realm.name, bot=email)
            return
        if do_regenerate_api_key is None:
            boxpilot_result(error="key-not-renewed", realm=realm.name, bot=email)
            return

    # A channel that is already there and that the owner did not make: nobody else may be in it.
    allowed = {owner.id} | ({bot.id} if bot is not None else set())
    for entry in channels:
        existing = Stream.objects.filter(realm=realm, name__iexact=entry["name"]).first()
        if existing is None or getattr(existing, "creator_id", None) == owner.id:
            continue
        members = set(
            Subscription.objects.filter(
                recipient_id=existing.recipient_id, active=True, user_profile__is_active=True
            ).values_list("user_profile_id", flat=True)
        )
        others = members - allowed
        if others:
            boxpilot_result(error="channel-shared", realm=realm.name, channel=existing.name, others=len(others))
            return

    bot_created = False
    reactivated = False
    if bot is None:
        bot = do_create_user(
            email=email,
            password=None,
            realm=realm,
            full_name=full_name,
            bot_type=UserProfile.DEFAULT_BOT,
            bot_owner=owner,
            acting_user=owner,
        )
        notify_created_bot(bot)
        bot_created = True
        api_key = bot.api_key
    else:
        if not bot.is_active:
            do_reactivate_user(bot, acting_user=owner)
            reactivated = True
        # A new key on every connect: whatever key existed before this run is void from here.
        api_key = do_regenerate_api_key(bot, owner)
        if not isinstance(api_key, str) or not api_key:
            bot.refresh_from_db()
            api_key = bot.api_key

    made = []
    for entry in channels:
        # Private: only the owner and the bot, until the owner adds someone in Zulip.
        stream, created = create_stream_if_needed(
            realm,
            entry["name"],
            invite_only=True,
            history_public_to_subscribers=True,
            stream_description=entry["description"],
            acting_user=owner,
        )
        bulk_add_subscriptions(realm, [stream], [owner, bot], acting_user=owner)
        made.append({"name": stream.name, "created": created, "private": bool(stream.invite_only)})

    boxpilot_result(
        realm=realm.name,
        url=getattr(realm, "url", None) or realm.uri,
        realmId=realm.id,
        bot=bot.delivery_email,
        apiKey=api_key,
        botCreated=bot_created,
        reactivated=reactivated,
        channels=made,
    )


boxpilot_connect()
