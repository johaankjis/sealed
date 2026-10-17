# Synthetic integration fixture; execute only inside CreateOS.
rows = con.execute(
    "SELECT region, sum(revenue) AS revenue, count(*) AS n "
    "FROM dataset GROUP BY region ORDER BY region"
).fetchall()
result = {
    "columns": ["region", "revenue"],
    "rows": [{"region": row[0], "revenue": row[1]} for row in rows],
    "groupSizes": [row[2] for row in rows],
}
