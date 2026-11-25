-- Public seat maps need occupancy state for every seat, but the public API
-- must select only non-identifying fields (id, label, row, col, state).
-- Never add passengerName, passengerEmail, passengerPhone or holderName to
-- public event responses.
DROP POLICY IF EXISTS rls_bus_seat_select ON "BusSeat";

CREATE POLICY rls_bus_seat_select ON "BusSeat" FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "Bus" b
      WHERE b."id" = "BusSeat"."busId"
        AND (
          app_can_access_event(b."eventId")
          OR app_user_can_see_event(b."eventId")
          OR (app_is_public() AND app_can_write_public_event(b."eventId"))
          OR (app_is_public() AND app_can_view_public_event(b."eventId"))
        )
    )
  );
