// mautrix-telegram - A Matrix-Telegram puppeting bridge
// Copyright (C) 2017 Tulir Asokan
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
const TelegramPeer = require("./telegram-peer")
const formatter = require("./formatter")

/**
 * Portal represents a portal from a Matrix room to a Telegram chat.
 */
class Portal {
	constructor(app, roomID, peer) {
		this.app = app
		this.type = "portal"

		this.roomID = roomID
		this.peer = peer
		this.accessHashes = new Map()
	}

	get id() {
		return this.peer.id
	}

	get receiverID() {
		return this.peer.receiverID
	}

	static fromEntry(app, entry) {
		if (entry.type !== "portal") {
			throw new Error("MatrixUser can only be created from entry type \"portal\"")
		}

		const portal = new Portal(app, entry.roomID || entry.data.roomID, TelegramPeer.fromSubentry(entry.data.peer))
		portal.photo = entry.data.photo
		portal.avatarURL = entry.data.avatarURL
		if (portal.peer.type === "channel") {
			portal.accessHashes = new Map(entry.data.accessHashes)
		}
		return portal
	}

	async syncTelegramUsers(telegramPOV, users) {
		if (!users) {
			if (!await this.loadAccessHash(telegramPOV)) {
				return false
			}
			const data = await this.peer.getInfo(telegramPOV)
			users = data.users
		}
		for (const userData of users) {
			const user = await this.app.getTelegramUser(userData.id)
			// We don't want to update avatars here, as it would likely cause a flood error
			await user.updateInfo(telegramPOV, userData, { updateAvatar: false })
			await user.intent.join(this.roomID)
		}
		return true
	}


	async copyTelegramPhoto(telegramPOV, sender, photo) {
		const size = photo.sizes.slice(-1)[0]
		const uploaded = await this.copyTelegramFile(telegramPOV, sender, size.location, photo.id)
		uploaded.info.h = size.h
		uploaded.info.w = size.w
		uploaded.info.size = size.size
		uploaded.info.orientation = 0
		return uploaded
	}

	async copyTelegramFile(telegramPOV, sender, location, id) {
		console.log(JSON.stringify(location, "", "  "))
		id = id || location.id
		const file = await telegramPOV.getFile(location)
		const uploaded = await sender.intent.getClient().uploadContent({
			stream: file.buffer,
			name: `${id}.${file.extension}`,
			type: file.mimetype,
		}, { rawResponse: false })
		uploaded.matrixtype = file.matrixtype
		uploaded.info = {
			mimetype: file.mimetype,
			size: location.size,
		}
		return uploaded
	}

	async updateAvatar(telegramPOV, photo) {
		if (!photo || this.peer.type === "user") {
			return false
		}

		if (this.photo && this.avatarURL &&
			this.photo.dc_id === photo.dc_id &&
			this.photo.volume_id === photo.volume_id &&
			this.photo.local_id === photo.local_id) {
			return false
		}

		const file = await telegramPOV.getFile(photo)
		const name = `${photo.volume_id}_${photo.local_id}.${file.extension}`

		const uploaded = await this.app.botIntent.getClient().uploadContent({
			stream: file.buffer,
			name,
			type: file.mimetype,
		}, { rawResponse: false })

		this.avatarURL = uploaded.content_uri
		this.photo = {
			dc_id: photo.dc_id,
			volume_id: photo.volume_id,
			local_id: photo.local_id,
		}

		await this.app.botIntent.setRoomAvatar(this.roomID, this.avatarURL)
		return true
	}

	loadAccessHash(telegramPOV) {
		return this.peer.loadAccessHash(this.app, telegramPOV, { portal: this })
	}

	async handleTelegramTyping(evt) {
		if (!this.isMatrixRoomCreated()) {
			return
		}
		const typer = await this.app.getTelegramUser(evt.from)
		// The Intent API currently doesn't allow you to set the
		// typing timeout. Once it does, we should set it to ~5.5s
		// as Telegram resends typing notifications every 5 seconds.
		typer.intent.sendTyping(this.roomID, true/*, 5500*/)
	}

	async handleTelegramServiceMessage(evt) {
		let matrixUser, telegramUser
		switch (evt.action._) {
		case "messageActionChatCreate":
			await this.createMatrixRoom(evt.source, { invite: [evt.source.matrixUser.userID] })
			// Falls through to invite everyone in initial user list
		case "messageActionChatAddUser":
			for (const userID of evt.action.users) {
				matrixUser = await this.app.getMatrixUserByTelegramID(userID)
				if (matrixUser) {
					matrixUser.join(this)
					this.invite(matrixUser.userID)
				}
				telegramUser = await this.app.getTelegramUser(userID)
				telegramUser.intent.join(this.roomID)
			}
			break
		case "messageActionChannelCreate":
			// Channels don't send initial user lists 3:<
			await this.createMatrixRoom(evt.source, { invite: [evt.source.matrixUser.userID] })
			break
		case "messageActionChatDeleteUser":
			matrixUser = await this.app.getMatrixUserByTelegramID(evt.action.user_id)
			if (matrixUser) {
				matrixUser.leave(this)
				this.kick(matrixUser.userID, "Left Telegram chat")
			}
			telegramUser = await this.app.getTelegramUser(evt.action.user_id)
			telegramUser.intent.leave(this.roomID)
			break
		case "messageActionChatEditPhoto":
			const sizes = evt.action.photo.sizes
			let largestSize = sizes[0]
			let largestSizePixels = largestSize.w * largestSize.h
			for (const size of sizes) {
				const pixels = size.w * size.h
				if (pixels > largestSizePixels) {
					largestSizePixels = pixels
					largestSize = size
				}
			}
			// TODO once permissions are synced, make the avatar change event come from the user who changed the avatar
			await this.updateAvatar(evt.source, largestSize.location)
			break
		case "messageActionChatEditTitle":
			this.peer.title = evt.action.title
			await this.save()
			const intent = await this.getMainIntent()
			await intent.setRoomName(this.roomID, this.peer.title)
			break
		default:
			console.log("Unhandled service message of type", evt.action._)
			console.log(evt.action)
		}
	}

	async handleTelegramMessage(evt) {
		if (!this.isMatrixRoomCreated()) {
			try {
				const result = await this.createMatrixRoom(evt.source, { invite: [evt.source.matrixUser.userID] })
				if (!result.roomID) {
					return
				}
			} catch (err) {
				console.error("Error creating room:", err)
				console.error(err.stack)
				return
			}
		}

		const sender = await this.app.getTelegramUser(evt.from)
		await sender.intent.sendTyping(this.roomID, false)

		if (evt.text && evt.text.length > 0) {
			if (evt.entities) {
				evt.html = formatter.telegramToMatrix(evt.text, evt.entities, this.app)
				sender.sendHTML(this.roomID, evt.html)
			} else {
				sender.sendText(this.roomID, evt.text)
			}
		}

		if (evt.photo) {
			const photo = await this.copyTelegramPhoto(evt.source, sender, evt.photo)
			photo.name = evt.caption || "Uploaded photo"
			sender.sendFile(this.roomID, photo)
		} else if (evt.document) {
			// TODO handle stickers better
			const file = await this.copyTelegramFile(evt.source, sender, evt.document)
			if (evt.caption) {
				file.name = evt.caption
			} else if (file.matrixtype === "m.audio") {
				file.name = "Uploaded audio"
			} else if (file.matrixtype === "m.video") {
				file.name = "Uploaded video"
			} else {
				file.name = "Uploaded document"
			}
			sender.sendFile(this.roomID, file)
		} else if (evt.geo) {
			sender.sendLocation(this.roomID, evt.geo)
		}
	}

	async handleMatrixEvent(sender, evt) {
		await this.loadAccessHash(sender.telegramPuppet)
		switch (evt.content.msgtype) {
		case "m.text":
			if (evt.content.format === "org.matrix.custom.html") {
				const { message, entities } = formatter.matrixToTelegram(evt.content.formatted_body, this.app)
				await sender.telegramPuppet.sendMessage(this.peer, message, entities)
			} else {
				await sender.telegramPuppet.sendMessage(this.peer, evt.content.body)
			}
			break
		case "m.video":
		case "m.audio":
		case "m.file":
			// TODO upload document
			//break
		case "m.image":
			const intent = await this.getMainIntent()
			await intent.sendMessage(this.roomID, {
				msgtype: "m.notice",
				body: "Sending files is not yet supported.",
			})
			break
		case "m.location":
			const [, lat, long] = /geo:([-]?[0-9]+\.[0-9]+)+,([-]?[0-9]+\.[0-9]+)/.exec()
			await sender.telegramPuppet.sendMedia(this.peer, {
				_: "inputMediaGeoPoint",
				geo_point: {
					_: "inputGeoPoint",
					lat: +lat,
					long: +long,
				},
			})
			break
		default:
			console.log("Unhandled event:", evt)
		}
	}

	isMatrixRoomCreated() {
		return !!this.roomID
	}

	async getMainIntent() {
		return this.peer.type === "user"
			? (await this.app.getTelegramUser(this.peer.id)).intent
			: this.app.botIntent
	}

	async invite(users) {
		const intent = await this.getMainIntent()
		// TODO check membership before inviting?
		if (Array.isArray(users)) {
			for (const userID of users) {
				if (typeof userID === "string") {
					intent.invite(this.roomID, userID)
				}
			}
		} else if (typeof users === "string") {
			intent.invite(this.roomID, users)
		}
	}

	async kick(users, reason) {
		const intent = await this.getMainIntent()
		if (Array.isArray(users)) {
			for (const userID of users) {
				if (typeof userID === "string") {
					intent.kick(this.roomID, users, reason)
				}
			}
		} else if (typeof users === "string") {
			intent.kick(this.roomID, users, reason)
		}
	}

	async createMatrixRoom(telegramPOV, { invite = [], inviteEvenIfNotCreated = true } = {}) {
		if (this.roomID) {
			if (invite && inviteEvenIfNotCreated) {
				await this.invite(invite)
			}
			return {
				created: false,
				roomID: this.roomID,
			}
		}
		if (this.creatingMatrixRoom) {
			await new Promise(resolve => setTimeout(resolve, 1000))
			return {
				created: false,
				roomID: this.roomID,
			}
		}
		this.creatingMatrixRoom = true

		if (!await this.loadAccessHash(telegramPOV)) {
			this.creatingMatrixRoom = false
			throw new Error("Failed to load access hash.")
		}

		let room, info, users
		try {
			({ info, users } = await this.peer.getInfo(telegramPOV))
			if (this.peer.type === "chat") {
				room = await this.app.botIntent.createRoom({
					options: {
						name: info.title,
						topic: info.about,
						visibility: "private",
						invite,
					},
				})
			} else if (this.peer.type === "channel") {
				room = await this.app.botIntent.createRoom({
					options: {
						name: info.title,
						topic: info.about,
						visibility: info.username ? "public" : "private",
						room_alias_name: info.username
							? this.app.config.bridge.alias_template.replace("${NAME}", info.username)
							: undefined,
						invite,
					},
				})
			} else if (this.peer.type === "user") {
				const user = await this.app.getTelegramUser(info.id)
				await user.updateInfo(telegramPOV, info, { updateAvatar: true })
				room = await user.intent.createRoom({
					createAsClient: true,
					options: {
						name: this.peer.id === this.peer.receiverID
							? "Saved Messages (Telegram)"
							: undefined, //user.getDisplayName(),
						topic: "Telegram private chat",
						visibility: "private",
						invite,
					},
				})
			} else {
				this.creatingMatrixRoom = false
				throw new Error(`Unrecognized peer type: ${this.peer.type}`)
			}
		} catch (err) {
			this.creatingMatrixRoom = false
			throw err instanceof Error ? err : new Error(err)
		}

		this.roomID = room.room_id
		this.creatingMatrixRoom = false
		this.app.portalsByRoomID.set(this.roomID, this)
		await this.save()
		if (this.peer.type !== "user") {
			try {
				await this.syncTelegramUsers(telegramPOV, users)
				if (info.photo && info.photo.photo_big) {
					await this.updateAvatar(telegramPOV, info.photo.photo_big)
				}
			} catch (err) {
				console.error(err)
				if (err instanceof Error) {
					console.error(err.stack)
				}
			}
		}
		return {
			created: true,
			roomID: this.roomID,
		}
	}

	async updateInfo(telegramPOV, dialog) {
		if (!dialog) {
			console.log("updateInfo called without dialog data")
			const { user } = this.peer.getInfo(telegramPOV)
			if (!user) {
				throw new Error("Dialog data not given and fetching data failed")
			}
			dialog = user
		}
		let changed = false
		if (this.peer.type === "channel") {
			if (telegramPOV && this.accessHashes.get(telegramPOV.userID) !== dialog.access_hash) {
				this.accessHashes.set(telegramPOV.userID, dialog.access_hash)
				changed = true
			}
		}
		if (this.peer.type === "user") {
			const user = await this.app.getTelegramUser(this.peer.id)
			await user.updateInfo(telegramPOV, dialog)
		} else if (dialog.photo && dialog.photo.photo_big) {
			changed = await this.updateAvatar(telegramPOV, dialog.photo.photo_big) || changed
		}
		changed = this.peer.updateInfo(dialog) || changed
		if (changed) {
			this.save()
		}
		return changed
	}

	toEntry() {
		return {
			type: this.type,
			id: this.id,
			receiverID: this.receiverID,
			roomID: this.roomID,
			data: {
				peer: this.peer.toSubentry(),
				photo: this.photo,
				avatarURL: this.avatarURL,
				accessHashes: this.peer.type === "channel"
					? Array.from(this.accessHashes)
					: undefined,
			},
		}
	}

	save() {
		return this.app.putRoom(this)
	}
}

module.exports = Portal
