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
from zerver.models import Realm, UserProfile
from zerver.models.users import get_user_by_delivery_email


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
    bot_created = False
    reactivated = False
    try:
        bot = get_user_by_delivery_email(email, realm)
        if not bot.is_bot:
            boxpilot_result(error="address-taken", realm=realm.name, bot=email)
            return
        if not bot.is_active:
            do_reactivate_user(bot, acting_user=owner)
            reactivated = True
    except UserProfile.DoesNotExist:
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
        apiKey=bot.api_key,
        botCreated=bot_created,
        reactivated=reactivated,
        channels=made,
    )


boxpilot_connect()
