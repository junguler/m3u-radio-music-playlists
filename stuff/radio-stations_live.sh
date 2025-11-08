# extract sitemap, country names and list of genre and languages ids
curl -s https://radiostationslive.com/sitemap.xml | htmlq loc -t | awk -F '/' '{print $5}' | awk NF | sed 's|.xml||g' > sitemap.txt
for i in $(cat sitemap.txt) ; do curl -s https://radiostationslive.com/sitemap/$i.xml | htmlq loc -t | grep '/station/' | awk -F '/' '{print $5}' | tail -n +4 > A-$i.txt ; done
curl -s https://radiostationslive.com/music-genres | htmlq -a href a | grep 'music-genres/' | awk -F '/' '{print $2}' > genres.txt
curl -s https://radiostationslive.com/languages | htmlq -a href a | grep 'languages/' | awk -F '/' '{print $2}' | sort > languages.txt

# extract genres and language page names
for i in "" \?page={2..100} ; do for j in $(cat genres.txt) ; do curl -s https://radiostationslive.com/music-genres/$j$i | htmlq -a href a | grep '/station/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..100} ; do for j in $(cat languages.txt) ; do curl -s https://radiostationslive.com/languages/$j$i | htmlq -a href a | grep '/station/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiostationslive.com/station/$j > mep1 ; paste -d ',' <(cat mep1 | grep 'data-imagelink' | awk -F '"' '{print $2}' | head -n 1 | cut -d '/' -f1-3 | awk '{print "https://radiostationslive.com/uploads/" $0}' | awk '{ print "\"" $0 "\"" }') <(cat mep1 | htmlq -t h1) | awk 'NR==1 {$0="#EXTINF:-1 tvg-logo=" $0} 1' >> A$i ; cat mep1 | grep 'data-streamlink' | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done