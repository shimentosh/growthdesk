/*
 * Well-known disposable / throwaway email domains, refused at sign-up when the
 * platform setting `blockDisposableDomains` is on (the default). Admins add
 * their own with `extraBlockedDomains`.
 *
 * MAINTENANCE: this is a static snapshot of the most common services, not a
 * complete list — new throwaway domains appear every week. Refresh it from a
 * maintained source (e.g. github.com/disposable-email-domains/disposable-email-domains)
 * from time to time, and use extraBlockedDomains for anything urgent.
 * Subdomains match too: "x.mailinator.com" is blocked by "mailinator.com".
 */
const DOMAINS = `
0-mail.com 0815.ru 0clickemail.com 0wnd.net 0wnd.org 10mail.org 10minutemail.co.uk 10minutemail.com 10minutemail.de
10minutemail.net 10minutemail.org 10minutesmail.com 123-m.com 1chuan.com 1pad.de 1secmail.com 1secmail.net
1secmail.org 1zhuan.com 20minutemail.com 20minutemail.it 2prong.com 30minutemail.com 33mail.com 3d-painting.com
4warding.com 4warding.net 4warding.org 60minutemail.com 675hosting.com 675hosting.net 675hosting.org 6paq.com 6url.com
75hosting.com 75hosting.net 75hosting.org 7tags.com 9ox.net a-bc.net afrobacon.com ajaxapp.net amilegit.com amiri.net
amiriindustries.com anonbox.net anonymbox.com antichef.com antichef.net antispam.de armyspy.com baxomale.ht.cx
beefmilk.com binkmail.com bio-muesli.net bobmail.info bodhi.lawlita.com bofthew.com bootybay.de boun.cr bouncr.com
brefmail.com broadbandninja.com bsnow.net bugmenot.com bumpymail.com burnthespam.info burstmail.info buymoreplays.com
byom.de card.zp.ua casualdx.com cek.pm chammy.info childsavetrust.org chogmail.com choicemail1.com clixser.com
cmail.net cmail.org coldemail.info cool.fr.nf correo.blogos.net cosmorph.com courriel.fr.nf courrieltemporaire.com
crapmail.org cubiclink.com curryworld.de cuvox.de dacoolest.com dandikmail.com dayrep.com dcemail.com deadaddress.com
deadspam.com delikkt.de despam.it despammed.com devnullmail.com dfgh.net digitalsanctuary.com discard.email
discardmail.com discardmail.de disposable.com disposableaddress.com disposableemailaddresses.com disposableinbox.com
dispose.it disposeamail.com disposemail.com dispostable.com dm.w3internet.co.uk dodgeit.com dodgit.com dodgit.org
donemail.ru dontreg.com dontsendmespam.de drdrb.com drdrb.net dropmail.me dump-email.info dumpandjunk.com dumpmail.de
dumpyemail.com e4ward.com easytrashmail.com einrot.com email60.com emaildienst.de emailgo.de emailias.com emailigo.de
emailinfive.com emaillime.com emailmiser.com emailondeck.com emailsensei.com emailtemporanea.com emailtemporanea.net
emailtemporar.ro emailtemporario.com.br emailthe.net emailtmp.com emailto.de emailwarden.com emailx.at.hm
emailxfer.com emeil.in emeil.ir emz.net enterto.com ephemail.net etranquil.com etranquil.net etranquil.org evopo.com
explodemail.com eyepaste.com fakeinbox.com fakeinformation.com fakemail.fr fakemailgenerator.com fakemailz.com
fammix.com fansworldwide.de fantasymail.de fastacura.com fastchevy.com fastchrysler.com fastkawasaki.com fastmazda.com
fastmitsubishi.com fastnissan.com fastsubaru.com fastsuzuki.com fasttoyota.com fastyamaha.com fightallspam.com
filzmail.com fixmail.tk fizmail.com fleckens.hu flyspam.com frapmail.com friendlymail.co.uk fuckingduh.com
fudgerub.com fux0ringduh.com garliclife.com gehensiemirnichtaufdensack.de get1mail.com get2mail.fr getairmail.com
getmails.eu getnada.com getonemail.com getonemail.net ghosttexter.de girlsundertheinfluence.com gishpuppy.com
gowikibooks.com gowikicampus.com gowikicars.com gowikifilms.com gowikigames.com gowikimusic.com gowikinetwork.com
gowikitravel.com gowikitv.com great-host.in greensloth.com grr.la gsrv.co.uk guerillamail.biz guerillamail.com
guerillamail.net guerillamail.org guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info
guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com h.mintemail.com h8s.org haltospam.com
harakirimail.com hatespam.org herp.in hidemail.de hidzz.com hmamail.com hochsitze.com hopemail.biz hulapla.de
ieatspam.eu ieatspam.info ihateyoualot.info iheartspam.org imails.info inbax.tk inbox.si inboxalias.com inboxclean.com
inboxclean.org inboxkitten.com incognitomail.com incognitomail.net incognitomail.org insorg-mail.info ipoo.org
jetable.com jetable.fr.nf jetable.net jetable.org jnxjn.com jourrapide.com junk1e.com kasmail.com kaspop.com
keepmymail.com killmail.com killmail.net kir.ch.tc klassmaster.com klassmaster.net klzlk.com koszmail.pl
kulturbetrieb.info kurzepost.de lawlita.com letthemeatspam.com lhsdv.com lifebyfood.com link2mail.net litedrop.com
lol.ovpn.to lookugly.com lopl.co.cc lortemail.dk lovemeleaveme.com lr78.com lroid.com lukop.dk m4ilweb.info
maboard.com mail-filter.com mail-temporaire.fr mail.mezimages.net mail.zp.ua mail1a.de mail21.cc mail2rss.org
mail333.com mail4trash.com mailbidon.com mailblocks.com mailcatch.com maildrop.cc maildx.com maileater.com
mailexpire.com mailfa.tk mailforspam.com mailfreeonline.com mailguard.me mailimate.com mailin8r.com mailinater.com
mailinator.com mailinator.net mailinator.org mailinator2.com mailincubator.com mailismagic.com mailme.ir mailme.lv
mailme24.com mailmetrash.com mailmoat.com mailnator.com mailnesia.com mailnull.com mailpick.biz mailrock.biz
mailsac.com mailscrap.com mailshell.com mailsiphon.com mailslapping.com mailslite.com mailtemp.info mailtome.de
mailtothis.com mailtrash.net mailtv.net mailtv.tv mailzilla.com mailzilla.org makemetheking.com manybrain.com mbx.cc
mega.zik.dj meinspamschutz.de meltmail.com messagebeamer.de mezimages.net mierdamail.com migmail.pl mintemail.com
mjukglass.nu moakt.com mobi.web.id mobileninja.co.uk moburl.com mohmal.com moncourrier.fr.nf monemail.fr.nf
monmail.fr.nf msa.minsmail.com mt2009.com mt2014.com mx0.wwwnew.eu my10minutemail.com mycleaninbox.net myemailboxy.com
mymail-in.net mynetstore.de mypacks.net mypartyclip.de myphantomemail.com mysamp.de myspaceinc.com myspaceinc.net
myspaceinc.org myspacepimpedup.com mytemp.email mytempemail.com mytempmail.com mytrashmail.com nabuma.com nepwk.com
nervmich.net nervtmich.net netmails.com netmails.net neverbox.com nice-4u.com nincsmail.hu nmail.cf nobulk.com
noclickemail.com nogmailspam.info nomail.xl.cx nomail2me.com nomorespamemails.com nospam.ze.tc nospam4.us nospamfor.us
nospammail.net notmailinator.com nowmymail.com nurfuerspam.de nwldx.com objectmail.com obobbo.com odnorazovoe.ru
oneoffemail.com onewaymail.com onlatedotcom.info oopi.org opayq.com ordinaryamerican.net otherinbox.com ourklips.com
outlawspam.com ovpn.to owlpic.com pancakemail.com pjjkp.com plexolan.de politikerclub.de poofy.org pookmail.com
privy-mail.com privymail.de proxymail.eu prtnx.com punkass.com putthisinyourspamdatabase.com quickinbox.com
quickmail.nl rcpt.at reallymymail.com receiveee.com recode.me recursor.net regbypass.com rejectmail.com rhyta.com
rklips.com rmqkr.net rppkn.com rtrtr.com s0ny.net safe-mail.net safersignup.de safetymail.info safetypost.de
sandelf.de saynotospams.com schafmail.de schrott-email.de secretemail.de secure-mail.biz selfdestructingmail.com
sendspamhere.com sharklasers.com shieldedmail.com shiftmail.com shitmail.me shitware.nl shortmail.net sinnlos-mail.de
siteposter.net skeefmail.com slaskpost.se slopsbox.com slushmail.com smashmail.de smellfear.com snakemail.com
sneakemail.com sneakmail.de snkmail.com sofimail.com sofort-mail.de sogetthis.com soodonims.com spam.la spam.su
spam4.me spamail.de spamarrest.com spamavert.com spambob.com spambob.net spambob.org spambog.com spambog.de spambog.ru
spambox.info spambox.irishspringrealty.com spambox.us spamcannon.com spamcannon.net spamcero.com spamcon.org
spamcorptastic.com spamcowboy.com spamcowboy.net spamcowboy.org spamday.com spamex.com spamfree.eu spamfree24.com
spamfree24.de spamfree24.eu spamfree24.info spamfree24.net spamfree24.org spamgoes.in spamgourmet.com spamgourmet.net
spamgourmet.org spamherelots.com spamhereplease.com spamhole.com spamify.com spaminator.de spamkill.info spaml.com
spaml.de spammotel.com spamobox.com spamoff.de spamslicer.com spamspot.com spamthis.co.uk spamthisplease.com
spamtrail.com spamtroll.net speed.1s.fr spoofmail.de stuffmail.de super-auswahl.de supergreatmail.com supermailer.jp
superrito.com superstachel.de suremail.info svk.jp sweetxxx.de tafmail.com tagyourself.com talkinator.com
tapchicuoihoi.com teewars.org teleworm.com teleworm.us temp-mail.io temp-mail.org temp-mail.ru temp.emeraldwebmail.com
temp.headstrong.de tempail.com tempalias.com tempe-mail.com tempemail.biz tempemail.co.za tempemail.com tempemail.net
tempinbox.co.uk tempinbox.com tempmail.co tempmail.de tempmail.dev tempmail.eu tempmail.it tempmail.net tempmail.plus
tempmail.us tempmail2.com tempmaildemo.com tempmailer.com tempmailer.de tempomail.fr temporarily.de
temporarioemail.com.br temporaryemail.net temporaryemail.us temporaryforwarding.com temporaryinbox.com
temporarymailaddress.com tempr.email tempsky.com tempthe.net tempymail.com thanksnospam.info thankyou2010.com thc.st
thelimestones.com thisisnotmyrealemail.com thismail.net throam.com throwam.com throwawayemailaddress.com
throwawaymail.com tilien.com tittbit.in tmail.ws tmailinator.com toiea.com tradermail.info trash-amil.com
trash-mail.at trash-mail.com trash-mail.de trash2009.com trash2010.com trash2011.com trashbox.eu trashdevil.com
trashdevil.de trashemail.de trashmail.at trashmail.com trashmail.de trashmail.me trashmail.net trashmail.org
trashmail.ws trashmailer.com trashymail.com trashymail.net trbvm.com trialmail.de trillianpro.com tryalert.com
turual.com twinmail.de tyldd.com uggsrock.com upliftnow.com uplipht.com uroid.com venompen.com veryrealemail.com
vidchart.com viditag.com viewcastmedia.com viewcastmedia.net viewcastmedia.org vomoto.com vpn.st vsimcard.com
vubby.com wasteland.rfc822.org webemail.me webm4il.info weg-werf-email.de wegwerf-email-addressen.de wegwerf-emails.de
wegwerfadresse.de wegwerfemail.com wegwerfemail.de wegwerfmail.de wegwerfmail.info wegwerfmail.net wegwerfmail.org
wh4f.org whatiaas.com whatpaas.com whatsaas.com whopy.com whyspam.me willhackforfood.biz willselfdestruct.com
winemaven.info wronghead.com wuzup.net wuzupmail.net www.e4ward.com www.gishpuppy.com www.mailinator.com wwwnew.eu
xagloo.com xemaps.com xents.com xmaily.com xoxy.net yapped.net yep.it yogamaven.com yopmail.com yopmail.fr yopmail.net
ypmail.webarnak.fr.eu.org yuurok.com z1p.biz zehnminuten.de zehnminutenmail.de zippymail.info zoaxe.com zoemail.org
zomg.info
`;

export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(DOMAINS.split(/\s+/).filter(Boolean));

/** True when `domain` or any parent of it is in `blocked`. */
export function domainListed(domain: string, blocked: ReadonlySet<string>): boolean {
  const parts = domain.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (blocked.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
