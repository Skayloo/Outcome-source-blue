using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Outcome.Db.Abstractions.Migrations
{
    /// <inheritdoc />
    public partial class VoiceChannelChats : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "chat_channel_id",
                table: "channels",
                type: "bigint",
                nullable: true);

            // Every voice room gets its chat (W3GWG-25): an ordinary text channel of the same name,
            // in the same place. Whatever was already written into a voice channel itself — the
            // first version of the room chat kept it there — moves into that chat.
            migrationBuilder.Sql(@"
DO $$
DECLARE r record; chat_id bigint;
BEGIN
  FOR r IN SELECT id, server_id, name, category, position FROM channels
           WHERE type = 'voice' AND NOT deleted AND chat_channel_id IS NULL ORDER BY id
  LOOP
    INSERT INTO channels (server_id, name, type, category, topic, position, slow_mode, archived, deleted,
                          voice_max_users, voice_max_video)
    VALUES (r.server_id, r.name, 'text', r.category, '', r.position, 0, FALSE, FALSE, 0, 25)
    RETURNING id INTO chat_id;
    UPDATE channels SET chat_channel_id = chat_id WHERE id = r.id;
    UPDATE messages SET channel_id = chat_id WHERE channel_id = r.id;
  END LOOP;
END $$;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "chat_channel_id",
                table: "channels");
        }
    }
}
